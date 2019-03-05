"use strict";

const zlib = require('zlib');
const aws = require('aws-sdk');
const proputils = require('watchtower-property-utils');


const ddb = new aws.DynamoDB();
const kinesis = new aws.Kinesis();

const debug      = process.env.DEBUG_WATCHTOWER;
const streamName = process.env.WATCHTOWER_INVOCATION_STREAM;

const eventUpdateRE = /\t#####EVENTUPDATE\[(([A-Za-z0-9\-_]+)\(([A-Za-z0-9\-_,.:/]*)\))]#####\n$/;

function createIngestionHandler (tableName, properties) {

    const propTerm = {};

    for (const property of properties) {
        propTerm[property.name] = proputils.getTerminatingTransitions(property);
    }

    return async function (event) {
        
        if (debug) {
            console.log(JSON.stringify(event));
        }
        
        const monitorInstancesToTrigger = new Set();

        const payload = new Buffer(event.awslogs.data, 'base64');

        let logBatch = JSON.parse(zlib.gunzipSync(payload).toString('ascii'));
        const logEvents = logBatch.logEvents;

        if (debug) {
            console.log(logEvents);
        }

        const entries = [];

        for (const logEvent of logEvents) {
            const eventUpdate = logEvent.message.match(eventUpdateRE);
            if (eventUpdate) {
                const eventType = eventUpdate[2];
                const eventParams = eventUpdate[3].split(',');
                for (const prop of properties) {

                    const eventTransitions = prop.stateMachine[eventType];

                    if (eventTransitions &&
                        (eventTransitions.filter ? eventTransitions.filter(...eventParams) : true)) {

                        const entry = {
                            id: logEvent.id.toString(), // Sort Key
                            type: eventType,
                            params: eventParams,
                            timestamp: logEvent.timestamp.toString(),
                            logGroup: logBatch.logGroup,
                            logStream: logBatch.logStream,
                            quantified: {},
                        };

                        const e = eventTransitions;

                        let propinstKey = prop.name;
                        for (const qvar of prop.quantifiedVariables) {
                            const varIDX = e.params.indexOf(qvar);
                            if (varIDX !== -1) {
                                propinstKey+=qvar;
                                propinstKey+=eventParams[varIDX];
                            }
                            entry.quantified[qvar] = eventParams[varIDX];
                        }
                        entry.propinst = propinstKey; // Partition Key

                        entries.push(entry);

                        if (propTerm[prop.name].has(eventType)) {
                            monitorInstancesToTrigger.add(JSON.stringify(entry.quantified));
                        }
                    }
                }
            } else {
                throw `Malformed event in log: ${logEvent}`;
            }
        }

        const batchedEntries = [];

        for (let i = 0; i < entries.length; i += 25) {
            batchedEntries.push(entries.slice(i, i + 25));
        }

        const calls = [];

        for (const batch of batchedEntries) {

            const params = {};

            params.RequestItems = {};
            params.RequestItems[tableName] = [];


            for (const item of batch) {
                const putRequest = {
                    PutRequest: {
                        Item: {
                            "propinst": {S: item.propinst},
                            "id": {S: item.id},
                            "type": {S: item.type},
                            "params": {L: item.params.map((param) => ({S: param}))},
                            "timestamp": {N: item.timestamp},
                            "logGroup": {S: item.logGroup},
                            "logStream": {S: item.logStream},
                        }
                    }
                };

                for (const varname in item.quantified) {
                    if (item.quantified.hasOwnProperty(varname)) {
                        putRequest.PutRequest.Item[varname] = {S: item.quantified[varname]};
                    }
                }
                params.RequestItems[tableName].push(putRequest);
            }
            
            if (debug) {
                console.log("** DDB call:");
                console.log(params)               
            }

            calls.push(ddb.batchWriteItem(params).promise());
        }

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

        if (debug) {           
            console.log("** Kinesis call:");
            console.log(params);
            console.log(monitorInstancesToTrigger);
        }
        return Promise.all(calls)
            .then(() => params.Records.length > 0 ? kinesis.putRecords(params).promise() : undefined);

    };
}


module.exports.createIngestionHandler = createIngestionHandler;
