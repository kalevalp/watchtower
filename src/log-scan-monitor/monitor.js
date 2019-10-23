const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
const ses = new aws.SES();
const cwl = new aws.CloudWatchLogs();
const proputils = require('watchtower-property-utils');

const debug           = process.env.DEBUG_WATCHTOWER;
const eventTable      = process.env['WATCHTOWER_EVENT_TABLE'];
const checkpointTable = process.env['WATCHTOWER_CHECKPOINT_TABLE'];

const profile = process.env.PROFILE_WATCHTOWER;
const ingestionTimeOut = process.env.PROCESSING_LAMBDA_TIMEOUT;


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

        const monitorInstances = [];
        for (const record of event.Records) {
            let inst = JSON.parse(Buffer.from(record.kinesis.data,'base64').toString());

            monitorInstances.push(handleMonitorInstance(inst, record.kinesis.approximateArrivalTimestamp, event.phase));
        }

        return Promise.all(monitorInstances).then(() => event);
    }
}

function updateInstanceStatus(instance, isDischarged, tableName, state, timestamp, eventID) {
    if (debug) console.log("Updating instance status: ", JSON.stringify({instance, isDischarged, tableName, state, timestamp, eventID}));

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
        params.ExpressionAttributeNames[ "#S" ]  = "State";
        params.ExpressionAttributeNames[ "#TS" ] = "TimeStamp";
        params.ExpressionAttributeNames[ "#EID" ] = "EventID";

        params.ExpressionAttributeValues = {
            ":status": {
                S: "ACTIVE"
            },
            ":state": {
                S: state
            },
            ":time": {
                N: timestamp
            },
            ":eventid": {
                S: eventID
            },
        };
        params.UpdateExpression = "SET #ST = :status, #S = :state, #TS = :time, #EID = :eventid"
    }
    params.Key =  {"propinst" : {S : instance}};
    params.TableName = tableName;

    if (debug) console.log("Writing checkpoint to ddb:", JSON.stringify(params));

    return ddb.updateItem(params).promise();
}

// Sort by timestamp, with id being a tie-breaker
function eventOrderComparator(a, b) {
    return a.timestamp === b.timestamp ? a.id - b.id : a.timestamp - b.timestamp;
}

function monitorFactory(prop) {
    if (debug) {
        console.log(JSON.stringify(prop));
    }

    return async function(instance, arrivalTimestamp, phase) {
	if (debug) console.log("Running checker, phase: ", phase);

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

        function updateInstanceExpiration(e) {
            const params = {
                Key: {
                    propinst: e.propinst,
                    id: e.id,
                },
                ExpressionAttributeNames: {
                    "#TTL": "expiration"
                },
                ExpressionAttributeValues: {
                    ":exp": {
                        N: (Math.ceil(Date.now() / 1000) + 1).toString(), // Could go even safer and add lambda t/o instead of 1s.
                    },
                },
                UpdateExpression: "SET #TTL = :exp",
                TableName: eventTable,
            };
            return ddb.updateItem(params).promise();
        }

        if (checkpoint.Item &&
            checkpoint.Item.Status &&
            checkpoint.Item.Status.S === "DISCHARGED") {
            // received some terminating event after the property instance had been discharged. Need to do some GC.
            const eventTimestamp = checkpoint.Item.Timestamp.N;
            const queryParams = {
                TableName: eventTable,
                KeyConditionExpression: `propinst = :keyval`,
                ExpressionAttributeValues: {":keyval": {"S": `${proputils.getInstance(prop,instance)}`}},
                // TODO - add a timestamp filter.
            };

            const events = await getEvents([], queryParams);
            return Promise.all(events.filter(e => !e.Expiration).map(e => {
                return updateInstanceExpiration(e);
            }));
        }

        const preCallTime = Date.now();
        // const preCallTime = Math.ceil(Date.now()/1000);

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
            .then(results => results.sort(eventOrderComparator))
            .then(async results => {
                if (debug) console.log("Events: ", JSON.stringify(results));
                if (debug) console.log("Events.timestamps: ", JSON.stringify(results.map(e => e.timestamp)));

                const stabilityTime = preCallTime - ingestionTimeOut*1000 - 1000; // preCallTime is in (ms), rest is in (s).

                if (debug) console.log("stabilityTime: ", stabilityTime);

                const stablePrefix = results.filter(e => Number(e.timestamp.N) < stabilityTime);
                const partialTail = results.filter(e => Number(e.timestamp.N) >= stabilityTime);

                if (debug) console.log("Stable prefix: ", JSON.stringify(stablePrefix));
                if (debug) console.log("Partial tail: ", JSON.stringify(partialTail));

                let state;
                let lastProcessedEvent;

                const stableIntermediateState = proputils.runProperty(prop, stablePrefix, instance);
                state = stableIntermediateState.state;
                lastProcessedEvent = stableIntermediateState.lastProcessedEvent;

		// Only run the unstable part in the initial run of the checker.
		if (phase === 'initialPhase') {
                    const partialExecutionState = proputils.runProperty(prop, partialTail, instance, state);
                    state = partialExecutionState.state;
                    lastProcessedEvent = partialExecutionState.lastProcessedEvent;
		}

                // Handling the state the FSM ended up in after processing all the events.
                if (state.curr === 'FAILURE') {
		    /* Optimizing reporting.
		     * If the violation is in the partial execution, and we're in the initial call, check if there can be a
		     * non violating extension. If there cannot, then this is a real violation.
		     * */
                    // Check if, given the violation, there exists an extension (within the eventual consistency window) that does not lead to a violation.
                    const canHazExtenstion = proputils.hasNonViolatingExtension(prop, stablePrefix, partialTail, instance);
		    const shouldCaveat = canHazExtenstion && phase === 'initialPhase';

                    // Report to the user that the property had been violated.
		    const caveat = '\n\nNote that due to eventual consistency concerns, this violation may be spurious. \nWe will recheck the property as soon as the system has stabilized, and will report a definitive answer shortly.';
                    const params = {
                        Destination: { ToAddresses: [ 'mossie.torp@ethereal.email' ] },
                        Message: {
                            Body: { Text: { Data: `Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}.${shouldCaveat ? caveat : ''}`} },
                            Subject: { Data: `${shouldCaveat ? 'Potential ' : ''}PROPERTY VIOLATION: ${prop.name}` }
                        },
                        Source: 'mossie.torp@ethereal.email',
                    };
                    await ses.sendEmail(params).promise();

                    let arrivalTimeText = '';

                    if (profile) {
                        arrivalTimeText = ` Kinesis arrival timestamp @@${arrivalTimestamp}@@.`
                    }
                    console.log(`Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}. Failure triggered by event produced by Lambda invocation ${lastProcessedEvent.invocation.S}.${arrivalTimeText}`);
                } else if (state.curr === 'SUCCESS') {
                    console.log(`Property ${prop.name} holds for property instance ${JSON.stringify(instance)}`);
                } else {
                    console.log(`Property ${prop.name} was not violated (but might be violated by future events) for property instance ${JSON.stringify(instance)}`);
                }

                // GC
                if (['FAILURE', 'SUCCESS'].includes(stableIntermediateState.state.curr)){
                    // Mark instance as discharged
                    await updateInstanceStatus(proputils.getInstance(prop,instance), true, checkpointTable);
                } else {
                    // Checkpoint the stable part of the instance execution
                    const lastEvent = stableIntermediateState.lastProcessedEvent;
		    if (debug) console.log("Checkpointing stable. Last event: ", JSON.stringify(lastEvent));
		    if (lastEvent && stableIntermediateState.state && lastEvent.timestamp && lastEvent.id)
			await updateInstanceStatus(proputils.getInstance(prop,instance), false, checkpointTable, stableIntermediateState.state.curr, lastEvent.timestamp.N, lastEvent.id.S);
                }

                // Mark TTL for all stable instance events (not projections).
                return Promise.all(stablePrefix.filter(e => e.propinst.S === proputils.getInstance(prop,instance)) // Removes projections
                    .map(e => updateInstanceExpiration(e)));
            })
            .catch((err) => console.log(err));
    }
}

module.exports.kinesisListenerFactory = kinesisListenerFactory;
module.exports.monitorFactory = monitorFactory;


if (process.argv[2] === "test") {
    const input = {
        "Records": [
            {
                "kinesis": {
                    "kinesisSchemaVersion": "1.0",
                    "partitionKey": "\"{\\\"eventid\\\":\\\"9b1596b2-4b34-46e9-84ba-cd742c5d49c1\\\"}\"",
                    "sequenceNumber": "49600642134495777700315066552915572419924899399074840626",
                    "data": "eyJldmVudGlkIjoiOWIxNTk2YjItNGIzNC00NmU5LTg0YmEtY2Q3NDJjNWQ0OWMxIn0=",
                    "approximateArrivalTimestamp": 1571654144.01
                },
                "eventSource": "aws:kinesis",
                "eventVersion": "1.0",
                "eventID": "shardId-000000000003:49600642134495777700315066552915572419924899399074840626",
                "eventName": "aws:kinesis:record",
                "invokeIdentityArn": "arn:aws:iam::432356059652:role/testEventReaderRole",
                "awsRegion": "eu-west-1",
                "eventSourceARN": "arn:aws:kinesis:eu-west-1:432356059652:stream/WatchtowertestInvocationStream"
            }
        ]
    };

    const property = {
        name: 'dummy',
        quantifiedVariables: ['eventid'],
        projections: [['eventid']],
        stateMachine: {
            'DUMMY_EVENT_TYPE_A': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'intermediate',
                },
                'intermediate': {
                    to: 'SUCCESS',
                },
            },
            'DUMMY_EVENT_TYPE_B': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'SUCCESS',
                },
                'intermediate': {
                    to: 'FAILURE',
                },
            },
        },
    };

    const handler = kinesisListenerFactory(monitorFactory(property));

    handler(input);
}
