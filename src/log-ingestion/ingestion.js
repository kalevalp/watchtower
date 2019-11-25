"use strict";

const zlib = require('zlib');
const aws = require('aws-sdk');
const proputils = require('watchtower-property-utils');


const ddb = new aws.DynamoDB();
const kinesis = new aws.Kinesis();

const debug      = process.env.DEBUG_WATCHTOWER;
const profile    = process.env.PROFILE_WATCHTOWER;
const streamName = process.env.WATCHTOWER_INVOCATION_STREAM;
const eventTable = process.env.WATCHTOWER_EVENT_TABLE;

const eventUpdateRE = /([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\t#####EVENTUPDATE\[(.*)]#####\n$/;

function getPropTerm(properties) {
    const propTerm = {};

    for (const property of properties) {
        propTerm[property.name] = proputils.getTerminatingTransitions(property);
    }

    return propTerm;
}

function createKinesisIngestionHandler (properties) {
    const propTerm = getPropTerm(properties);

    if (debug) console.log("Creating kinesis ingestion handler. properties: ", JSON.stringify(properties));


    return (kinesisEvent, context) => {
        let functionTime;
        if (profile) functionTime = Date.now();
        if (debug) console.log("Started ingestion handler at time:", functionTime);

        const functionTimeout = Math.ceil(context.getRemainingTimeInMillis()/1000);
        if (debug) console.log(JSON.stringify(kinesisEvent));

        let logEvents = kinesisEvent.Records.map(
            record => {
                const le = {
                    data: JSON.parse(Buffer.from(record.kinesis.data,'base64').toString()),
                    id: `${record.kinesis.partitionKey}_${record.kinesis.sequenceNumber}`, // Kinesis partitionKey + seqnum combination is unique
                }

                if (profile) le.ingestionStartTime = functionTime.toString();
                if (profile) le.approximateKinesisArrivalTime = (record.kinesis.approximateArrivalTimestamp*1000).toString();

                if (debug) console.log("Ingesting kinesis event: ", JSON.stringify(le));

                return le;
            }
        );
        return handleLogEvents(logEvents, functionTimeout, properties, propTerm);
    }
}

function createLogIngestionHandler (properties) {
    const propTerm = getPropTerm(properties);

    return async function(event, context) {
        const functionTimeout = Math.ceil(context.getRemainingTimeInMillis()/1000);
        if (debug) console.log(JSON.stringify(event));

        const payload = new Buffer(event.awslogs.data, 'base64');

        let logBatch = JSON.parse(zlib.gunzipSync(payload).toString('ascii'));
        let logEvents = logBatch.logEvents;

        if (debug)   console.log(JSON.stringify(logEvents));
        if (profile) logEvents.forEach(logEvent => console.log(JSON.stringify(logEvent)));

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

        return handleLogEvents(logEvents, functionTimeout, properties, propTerm);
    }

}

async function handleLogEvents (logEvents, functionTimeout, properties, propTerm)  {
    const monitorInstancesToTrigger = new Set();

    const monitorInstancesToRecord = new Set();
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
                    timestamp: logEvent.data.timestamp.toString(),
                    quantified: {},
                    invocation: logEvent.data.invocationID,
                };

                if (profile) entry.ingestionStartTime = logEvent.ingestionStartTime;
                if (profile) entry.approximateKinesisArrivalTime = logEvent.approximateKinesisArrivalTime;

                for (const qvar of prop.quantifiedVariables) {
                    if (eventParams[qvar]) {
                        entry.quantified[qvar] = eventParams[qvar];
                    }
                }
                entry.propinst = proputils.getInstance(prop, eventParams, eventType); // Partition Key

                entries.push(entry);

                if (propTerm[prop.name].has(eventType)) { // Terminating transition
                    for (const proj of prop.projections) {
                        const quantifiedProj = {};
                        for (const qvar of proj) {
                            if (!eventParams[qvar]) throw new Error(`Expected param to appear in property! param: ${JSON.stringify(qvar)}, eventParams: ${JSON.stringify(eventParams)}, property: ${JSON.stringify(prop)}`);

                            quantifiedProj[qvar] = eventParams[qvar];
                        }

                    }

                    // Add an instance check notification
                    monitorInstancesToTrigger.add(JSON.stringify({propname: prop.name, instance: entry.quantified}));
                }
            }
        }
    }

    // Collect all async calls
    const calls = [];

    // Phase I - store events

    const batchedEntries = [];

    for (let i = 0; i < entries.length; i += 25) {
        batchedEntries.push(entries.slice(i, i + 25));
    }

    for (const batch of batchedEntries) {

        const params = {};

        params.RequestItems = {};
        params.RequestItems[eventTable] = [];


        for (const item of batch) {
            const putRequest = {
                PutRequest: {
                    Item: {
                        "propinst": {S: item.propinst},
                        "id": {S: item.id},
                        "type": {S: item.type},
                        "timestamp": {N: item.timestamp},
                        "invocation": {S: item.invocation},
                    }
                }
            };

            if (profile) putRequest.PutRequest.Item.ingestionStartTime = {N: item.ingestionStartTime};
            if (profile) putRequest.PutRequest.Item.approximateKinesisArrivalTime = {N: item.approximateKinesisArrivalTime};
            if (profile) putRequest.PutRequest.Item.ddbWriteTime = {N: Date.now().toString()};

            if (Object.keys(item.params).length > 0) {
                putRequest.PutRequest.Item.params = {M: {}}
                for (const param in item.params) {
                    putRequest.PutRequest.Item.params.M[param] = {S: item.params[param]};
                }
            }

            for (const varname in item.quantified) {
                if (item.quantified.hasOwnProperty(varname)) {
                    putRequest.PutRequest.Item[varname] = {S: item.quantified[varname]};
                }
            }
            if (debug) console.log(`** DDB call: ${JSON.stringify(putRequest)}`);

            params.RequestItems[eventTable].push(putRequest);
        }

        if (debug) console.log(JSON.stringify(params));

        calls.push(ddb.batchWriteItem(params).promise());
    }

    // Phase II - trigger instances by terminating events

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

    if (debug) console.log("** Kinesis call:", JSON.stringify(params));
    if (debug) console.log("** Monitor Instances To Trigger:", JSON.stringify(Array.from(monitorInstancesToTrigger)));

    return Promise.all(calls)
        .then(() => params.Records.length > 0 ? kinesis.putRecords(params).promise() : undefined);

}


module.exports.createIngestionHandler = createKinesisIngestionHandler;
module.exports.createKinesisIngestionHandler = createKinesisIngestionHandler;
module.exports.createLogIngestionHandler = createLogIngestionHandler;

