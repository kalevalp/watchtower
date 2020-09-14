const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
// const ses = new aws.SES();
const proputils = require('watchtower-property-utils');

const debug           = process.env.DEBUG_WATCHTOWER;
const eventTable      = process.env['WATCHTOWER_EVENT_TABLE'];
const checkpointTable = process.env['WATCHTOWER_CHECKPOINT_TABLE'];

const profile = process.env.PROFILE_WATCHTOWER;
const ingestionTimeOut = process.env.PROCESSING_LAMBDA_TIMEOUT;

function getEvents (collectedEvents, params) {
    if (debug) console.log("DDB call, getEvents: ", JSON.stringify(params));
    return ddb.query(params).promise()
        .then(data => {
            if (debug) console.log("DDB response, getEvents: ", JSON.stringify(data));
            if (data.LastEvaluatedKey) { // There are additional items in DynamoDB
                params.ExclusiveStartKey = data.LastEvaluatedKey;
                return getEvents(collectedEvents.concat(data.Items), params);
            } else {
                return collectedEvents.concat(data.Items)
            }
        })
}

function kinesisListenerFactory (handleMonitorInstance) {
    return (event) => {
        if (debug) {
            console.log(JSON.stringify(event));
        }
        let checkerFunctionInvokeTime = Date.now();

        const invokedInstances = [];

        const monitorInstances = [];
        for (const record of event.Records) {
            const instStr = Buffer.from(record.kinesis.data,'base64').toString();
            if (!invokedInstances.includes(instStr)){
                const inst = JSON.parse(instStr);
		const triggerStartTime = event.triggerStartTime ? event.triggerStartTime : checkerFunctionInvokeTime;
                monitorInstances.push(handleMonitorInstance(inst, record.kinesis.approximateArrivalTimestamp, checkerFunctionInvokeTime, triggerStartTime));
                invokedInstances.push(instStr);
            } else {
                if (debug) console.log("Invocation with multiple instances. Instance:", instStr);
            }
        }

        if (debug) console.log("Monitored instances: ", JSON.stringify(event.Records.map(record => Buffer.from(record.kinesis.data,'base64').toString())));

        return Promise.all(monitorInstances).then(() => event);
    }
}

function updateInstanceStatus(instance, isDischarged, tableName, states, timestamp, eventID) {
    // if (debug) console.log("Updating instance status: ", JSON.stringify({instance, isDischarged, tableName, states, timestamp, eventID}));

    const params = {};
    params.ExpressionAttributeNames = { "#ST": "Status" };

    if (isDischarged) {
        params.ExpressionAttributeValues = {
            ":status": {
                S: "DISCHARGED"
            }
        };
        params.UpdateExpression = "SET #ST = :status";
    } else {
        params.ExpressionAttributeNames[ "#SS" ]  = "States";
        params.ExpressionAttributeNames[ "#TS" ] = "TimeStamp";
        params.ExpressionAttributeNames[ "#EID" ] = "EventID";

        params.ExpressionAttributeValues = {
            ":status": {
                S: "ACTIVE"
            },
            ":states": {
                SS: states
            },
            ":time": {
                N: timestamp
            },
            ":eventid": {
                S: eventID
            },
        };
        params.UpdateExpression = "SET #ST = :status, #SS = :states, #TS = :time, #EID = :eventid"
    }
    params.Key =  {"propinst" : {S : instance}};
    params.TableName = tableName;

    if (debug) console.log("Writing checkpoint to ddb:", JSON.stringify(params));

    return ddb.updateItem(params).promise();
}

// Sort by timestamp, with id being a tie-breaker
function eventOrderComparator(a, b) {
    const ats = Number(a.timestamp.N);
    const bts = Number(b.timestamp.N);

    // Only tie-break on events from the same invocation
    if (ats === bts && a.invocation.S === b.invocation.S) {
	const idRegex = /^(.*)_([0-9]*$)/;
	const aparsed = a.id.S.match(idRegex);
	const bparsed = b.id.S.match(idRegex);
	if (aparsed && bparsed && aparsed[1] !== undefined && bparsed[1] !== undefined && aparsed[1] === bparsed[1]) {
	    const aid = BigInt(aparsed[2]);
	    const bid = BigInt(bparsed[2]);
	    return aid < bid ? -1 : 1;
	} else {
	    return 0;
	}
    } else {
	return ats - bts;
    }
}

function produceOrders(eventList) {
    const sorted = eventList.sort(eventOrderComparator);
    return sorted;
}

function monitorFactory(properties) {
    if (debug) {
        console.log(JSON.stringify(properties));
    }

    return async function(trigger, instanceTriggerKinesisTime, checkerFunctionInvokeTime, triggerStartTime) {
        if (debug) console.log("Running checker");

	const prop = properties.find(p => p.name === trigger.propname);
	const instance = trigger.instance;


        const ddbCalls = [];

        // Check for a checkpoint
        // If terminated, delete event and finish run
        // Else, add checkpoint time-stamp to query
        // At the end of the run, write checkpoint, and delete processed events.

        const params = {
            Key: {"propinst": {S: proputils.getInstance(prop,instance)}},
            TableName: checkpointTable,
        };
        const checkpoint = await ddb.getItem(params).promise();

        if (debug) console.log("Checkpoint is: ", JSON.stringify(checkpoint));

        function updateInstanceExpiration(events) {
            if (debug) console.log(`Running updates for ${events.length} events.`)
            for (const event of events) {
                event.expiration = {
                    N: (Math.ceil(Date.now() / 1000) + 1).toString(), // Could go even safer and add lambda t/o instead of 1s.
                }
            }

            const batchList = []
            for (let i = 0; i < events.length / 25 ; i++) {
                batchList.push(events.slice(i*25, (i+1)*25));
            }

            return Promise.all(batchList.map((batch, idx) => {
                if (debug) console.log(`Running updates for batch ${idx} of ${batchList.length}, with ${batch.length} events.`)

                const params = {RequestItems: {}};
                params.RequestItems[eventTable] = batch.map(item => ({PutRequest: { Item: item } }))

                return ddb.batchWriteItem(params).promise()
                    .then(() => {if (debug) console.log(`Finished updates for batch ${idx} of ${batchList.length}.`)});
            }));
        }

        if (checkpoint.Item &&
            checkpoint.Item.Status &&
            checkpoint.Item.Status.S === "DISCHARGED") {

            if (debug) console.log("Encountered discharged event. Checkpoint: ", JSON.stringify(checkpoint));

            // received some terminating event after the property instance had been discharged. Need to do some GC.
            const queryParams = {
                TableName: eventTable,
                KeyConditionExpression: `propinst = :keyval`,
                ExpressionAttributeValues: {":keyval": {"S": `${proputils.getInstance(prop,instance)}`}},
                FilterExpression: `attribute_not_exists(expiration)`
            };


            const events = await getEvents([], queryParams);

            if (debug) console.log("Marking events of discharged instance for deletion. events: ", JSON.stringify(events));

            return updateInstanceExpiration(events.filter(e => !e.expiration));
        }

        const preCallTime = Date.now();

        for (const proj of prop.projections) {

            let propinstKey = prop.name;

            for (const qvar of proj) {
                if (! instance[qvar]) {
                    console.log(`ERROR: Quantified variable ${qvar} not found in ${JSON.stringify(instance)}`);

                    throw `Instance is missing an assignment to quantified variable ${qvar}.`;
                }

                propinstKey+=qvar;
                propinstKey+=instance[qvar];
            }

            const queryRequest = {
                TableName: eventTable,
                KeyConditionExpression: `propinst = :keyval`,
                ExpressionAttributeValues: {":keyval": {"S": `${propinstKey}`}},
            };

            if (checkpoint.Items &&
                checkpoint.Items.Status &&
                checkpoint.Item.Status.S === "ACTIVE") {
                // Property is active and had been previously checkpointed. Need to start from the checkpoint.
                const eventTimestamp = checkpoint.Item.Timestamp.N;
                queryRequest.ExpressionAttributeValues[":ts"] = {"N": eventTimestamp};
                queryRequest.FilterExpression = "Timestamp > :ts" // TODO - add to filter a check for the existence of the ttl field.
            }

            ddbCalls.push(getEvents([], queryRequest));
        }

        return Promise.all(ddbCalls)
            .then(results => [].concat(...results)) // Return a single array consisting of all events.
            .then(results => produceOrders(results))
            .then(async order => {
                // if (debug) console.log("Events: ", JSON.stringify(order));
                // if (debug) console.log("Number of processed events: ", order.length);
                if (debug) console.log("Events.timestamps: ", JSON.stringify(order.map(e => e.timestamp.N)));

                const stabilityTime = preCallTime - ingestionTimeOut*1000 - 1000; // preCallTime is in (ms), rest is in (s).

                if (debug) console.log("stabilityTime: ", stabilityTime);

                const stableEvents = order.filter(e => Number(e.timestamp.N) < stabilityTime);

                if (debug) console.log(`Processing ${stableEvents.length} stable events out of a total of ${order.length} events.`);
                // if (debug) console.log("Stable events: ", JSON.stringify(stableEvents));

                const postRunStatus = proputils.runProperty(prop, stableEvents, instance);
                const states = postRunStatus.states;
                const lastProcessedEvent = postRunStatus.lastProcessedEvent;

                // Handling the state the FSM ended up in after processing all the events.
                if (states.some(state => state.curr === 'FAILURE')) {

                    // TODO - This is not necessarily the offending event.
                    if (profile) {
                        const profileReport = {
                            instance,
                            eventOccuredTimestamp: Number(lastProcessedEvent.timestamp.N),
                            eventKinesisArrivedTimestamp: Number(lastProcessedEvent.approximateKinesisArrivalTime.N),
                            ingestionFunctionStartTime: Number(lastProcessedEvent.ingestionStartTime.N),
                            ddbWriteTime: Number(lastProcessedEvent.ddbWriteTime.N),
                            instanceTriggerKinesisTime: instanceTriggerKinesisTime*1000,
			    triggerStartTime,
                            checkerFunctionInvokeTime,
                            violationDetectionTime : Date.now(),
                        }

                        console.log(`@@@@WT_PROF: FULL REPORT ---${JSON.stringify(profileReport)}---`);
                        console.log(`@@@@WT_PROF: VIOLATION REPORT DELAY: ${Date.now()-Number(lastProcessedEvent.timestamp.N)}(ms)`);
                    }

                    // Report to the user that the property had been violated.
                    // const params = {
                    //     Destination: { ToAddresses: [ 'mossie.torp@ethereal.email' ] },
                    //     Message: {
                    //         Body: { Text: { Data: `Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}.`} },
                    //         Subject: { Data: `PROPERTY VIOLATION: ${prop.name}` }
                    //     },
                    //     Source: 'mossie.torp@ethereal.email',
                    // };
                    // await ses.sendEmail(params).promise();

                    console.log(`Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}. Failure triggered by event produced by Lambda invocation ${lastProcessedEvent.invocation.S}.`);
                } else if (states.some(state => state.curr === 'SUCCESS')) {
                    console.log(`Property ${prop.name} holds for property instance ${JSON.stringify(instance)}`);
                } else {
                    console.log(`Property ${prop.name} was not violated (but might be violated by future events) for property instance ${JSON.stringify(instance)}`);
                }

                // GC
                if (states.some(state => ['FAILURE', 'SUCCESS'].includes(state.curr))) {
                    if (debug) console.log(`Discharged property. postRunStatus: `, JSON.stringify(postRunStatus));
                    // Mark instance as discharged
                    await updateInstanceStatus(proputils.getInstance(prop,instance), true, checkpointTable);
                } else {
                    // Checkpoint the stable part of the instance execution
                    if (debug) console.log("Checkpointing stable. Last event: ", JSON.stringify(lastProcessedEvent));
                    if (lastProcessedEvent && postRunStatus.states && lastProcessedEvent.timestamp && lastProcessedEvent.id) {
                        await updateInstanceStatus(
                            proputils.getInstance(prop,instance),
                            false,
                            checkpointTable,
                            postRunStatus.states.map(state => state.curr),
                            lastProcessedEvent.timestamp.N,
                            lastProcessedEvent.id.S);
                    }
                }

                // Mark TTL for all stable instance events (not projections).
                return updateInstanceExpiration(stableEvents.filter(e => e.propinst.S === proputils.getInstance(prop,instance))) // Removes projections
            })
            .catch((err) => console.log(err));
    }
}

module.exports.kinesisListenerFactory = kinesisListenerFactory;
module.exports.monitorFactory = monitorFactory;
