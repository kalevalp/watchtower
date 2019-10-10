"use strict";

const zlib = require('zlib');
const aws = require('aws-sdk');
const proputils = require('watchtower-property-utils');


const ddb = new aws.DynamoDB();
const kinesis = new aws.Kinesis();

const debug      = process.env.DEBUG_WATCHTOWER;
const profile    = process.env.PROFILE_WATCHTOWER;
const streamName = process.env.WATCHTOWER_INVOCATION_STREAM;

// const eventUpdateRE = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\t#####EVENTUPDATE\[(([A-Za-z0-9\-_]+)\(([A-Za-z0-9\-_,.:/]*)\))]#####\n$/;

// '#####EVENTUPDATE${JSON.stringify(event)}#####'
const eventUpdateRE = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\t#####EVENTUPDATE\[(.*)]#####\n$/;

function getPropTerm(properties) {
    const propTerm = {};

    for (const property of properties) {
        propTerm[property.name] = proputils.getTerminatingTransitions(property);
    }

    return propTerm;
}

function createKinesisIngestionHandler (eventsTableName, instanceRegistrationTableName, properties) {
    const propTerm = getPropTerm(properties);

    return (kinesisEvent, context) => {
        const functionTimeout = Math.ceil(context.getRemainingTimeInMillis()/1000);
        if (debug) console.log(JSON.stringify(kinesisEvent));

        let logEvents = kinesisEvent.Records.map(
            record => ({
                data: JSON.parse(Buffer.from(record.kinesis.data,'base64').toString()),
                approximateKinesisArrivalTime: record.kinesis.approximateArrivalTimestamp,
                id: `${record.kinesis.partitionKey}_${record.kinesis.sequenceNumber}`, // Kinesis partitionKey + seqnum combination is unique
            })
        );
        return handleLogEvents(logEvents, functionTimeout, propTerm);
    }
}

function createLogIngestionHandler (eventsTableName, instanceRegistrationTableName, properties) {
    const propTerm = getPropTerm(properties);

    return async function(event, context) {
        const functionTimeout = Math.ceil(context.getRemainingTimeInMillis()/1000);
        if (debug) console.log(JSON.stringify(event));

        const payload = new Buffer(event.awslogs.data, 'base64');

        let logBatch = JSON.parse(zlib.gunzipSync(payload).toString('ascii'));
        let logEvents = logBatch.logEvents;

        if (debug)   console.log(logEvents);
        if (profile) logEvents.forEach(logEvent => console.log(logEvent));

        if (!logEvents.every(logEvent => logEvent.match(eventUpdateRE)))
            throw `Malformed event in log: ${logEvents.find(logEvent => !logEvent.match(eventUpdateRE))}`;

        logEvents = logEvents.map(logEvent => {
            const eventUpdate = logEvent.message.match(eventUpdateRE);
            const data = JSON.parse(eventUpdate[2]);
            data.invocationID = eventUpdate[1];
            data.timestamp = logEvent.timestamp.toString();
            return {
                data,
                id: logEvent.id, // In this case, the cloudwatch log item id (should be unique ::shrug::)
            };
        });

        return handleLogEvents(logEvents, functionTimeout, propTerm);
    }

}

async function handleLogEvents (logEvents, functionTimeout, propTerm)  {
    const monitorInstancesToTrigger = new Set();
    const nonTerminatingInstancesToTrigger = new Set();

    const monitorInstancesToRecord = [];
    const entries = [];

    for (const logEvent of logEvents) {
        const eventType = logEvent.data.logEvent.name;
        const eventParams = logEvent.data.logEvent.params;

        for (const prop of properties) {

            const eventTransitions = prop.stateMachine[eventType];

            if (eventTransitions &&
                (eventTransitions.filter ? eventTransitions.filter(...Object.values(eventParams)) : true)) {

                const entry = {
                    id: logEvent.id, // Sort Key
                    type: eventType,
                    params: eventParams,
                    timestamp: logEvent.timestamp.toString(),
                    quantified: {},
                    invocation: logEvent.data.invocationID,
                };

                let propinstKey = prop.name;
                for (const qvar of prop.quantifiedVariables) {
                    if (eventParams[qvar]) {
                        propinstKey += qvar;
                        propinstKey += eventParams[qvar];
                        entry.quantified[qvar] = eventParams[qvar];
                    }
                }
                entry.propinst = propinstKey; // Partition Key

                entries.push(entry);

                if (propTerm[prop.name].has(eventType)) { // Terminating transition
                    // Record that a new instance check has been initiated
                    //   This is done to ensure that there are no false negatives (missed violations) that
                    //   are caused by a data race. Specifically, a non terminating transition which arrives
                    //   after a terminating transition that occured befor it.

                    // Plan: Whenever a terminating transition is encoutered, it essentially instantiates a property instance.
                    //       This property instance is considered 'alive' until such time as the system can be considered stable (i.e., eventual consistency has been achieved), at which point the instance can be killed.
                    //       Whenever a non terminating transition arrives, it should check if it is a transition relevant to a live property instance. If it is, then that live instance should be re-run.
                    //       The rate of this occurence should be checked.
                    //       TTL for property instances is Tlambdamax+epsilon. After that point no new out-of-order non-terminating events can arrive.
                    //       The timestamp of the non-terminating event should be earlier than that of the terminating event that initiated the instance instantiation.

                    // TODO - record instance.

                    for (proj of prop.projections) {
                        const quantifiedProj = {};
                        for (qvar of proj) {
                            if (!eventParams[qvar])  throw new Error('Expected param to appear in property!');

                            quantifiedProj[qvar] = eventParams[qvar];
                        }

                        monitorInstancesToRecord.push({'proj': JSON.stringify(quantifiedProj), 'instance': JSON.stringify(entry.quantified)});
                    }

                    // Add an instance check notification
                    monitorInstancesToTrigger.add(JSON.stringify(entry.quantified));
                } else { // Non-terminating transition

                    // TODO - check if the current event is relevant to a live property instance.
                    //        if it is, rerun that instance.
                    nonTerminatingInstancesToTrigger.add(JSON.stringify(entry.quantified));
                }
            }
        }
    }

    // Phase I - register instances

    const batchedRegistrations = [];

    for (let i = 0; i < registrations.length; i += 25) {
        batchedRegistrations.push(registrations.slice(i, i + 25));
    }

    for (const batch of batchedRegistrations) {
        const params = {};

        params.RequestItems = {};
        params.RequestItems[instanceRegistrationTableName] = [];


        for (const item of batch) {
            const putRequest = {
                PutRequest: {
                    Item: {
                        "projinst": {S: item.proj},
                        "propinst": {S: item.instance},
                        "expiration": {N: Math.floor(Date.now()/1000) + functionTimeout},
                    }
                }
            };
            if (debug) {
                console.log("** DDB call:");
                console.log(JSON.stringify(putRequest));
            }

            params.RequestItems[instanceRegistrationTableName].push(putRequest);
        }

        if (debug) {
            console.log(JSON.stringify(params));
        }

        calls.push(ddb.batchWriteItem(params).promise());

    }



    // Phase II - store events

    const batchedEntries = [];

    for (let i = 0; i < entries.length; i += 25) {
        batchedEntries.push(entries.slice(i, i + 25));
    }

    const calls = [];

    for (const batch of batchedEntries) {

        const params = {};

        params.RequestItems = {};
        params.RequestItems[eventsTableName] = [];


        for (const item of batch) {
            const putRequest = {
                PutRequest: {
                    Item: {
                        "propinst": {S: item.propinst},
                        "id": {S: item.id},
                        "type": {S: item.type},
                        "timestamp": {N: item.timestamp},
                        "logGroup": {S: item.logGroup},
                        "logStream": {S: item.logStream},
                        "invocation": {S: item.invocation},
                    }
                }
            };

            if (item.params.some(x => x !== '')) {
                putRequest.PutRequest.Item.params = {L: item.params.filter(x => x!=='').map((param) => ({S: param}))};
            }

            for (const varname in item.quantified) {
                if (item.quantified.hasOwnProperty(varname)) {
                    putRequest.PutRequest.Item[varname] = {S: item.quantified[varname]};
                }
            }
            if (debug) {
                console.log("** DDB call:");
                console.log(JSON.stringify(putRequest));
            }

            params.RequestItems[eventsTableName].push(putRequest);
        }

        if (debug) {
            console.log(JSON.stringify(params));
        }

        calls.push(ddb.batchWriteItem(params).promise());
    }

    // Phase III - trigger instances by terminating events

    const params = {
        Records: [],
        StreamName: streamName,
    };

    if (monitorInstancesToTrigger.size > 0) {

        for (const instance of monitorInstancesToTrigger) {
            params.Records.push({
                Data: instance,
                PartitionKey: JSON.stringify(instance).substring(0, 256),
            });
        }

        if (params.Records.length > 500)
            throw "FATAL ERROR: Too many invocation requests!";
    }

    // Phase IV - trigger instances by non-terminating events
    // TODO - some projections may trigger multiple instances. Needs to be taken into account.
    const resp = await Promise.all(
        Array.from(nonTerminatingInstancesToTrigger).map(proj => {
            const params = {
                ExpressionAttributeValues: {
                    ":v1": {
                        S: "No One You Know"
                    },
                    ":v2": {
                        N: Math.floor(Date.now()/1000)
                    },
                },
                KeyConditionExpression: "projinst = :v1 and expiration > :v2",
                ProjectionExpression: "propinst",
                TableName: instanceRegistrationTableName,
            };

            return ddb.query(params).promise();
        })
    );

    params.Records.concat(Array.from(new Set([].concat(...resp.map(data => data.Items))
        .map(item => item.propinst)))
        .map(instance => ({
            Data: instance,
            PartitionKey: JSON.stringify(instance).substring(0, 256),
        })))

    if (debug) {
        console.log("** Kinesis call:");
        console.log(params);
        console.log(monitorInstancesToTrigger);
    }
    return Promise.all(calls)
        .then(() => params.Records.length > 0 ? kinesis.putRecords(params).promise() : undefined);

}


module.exports.createIngestionHandler = createLogIngestionHandler;
