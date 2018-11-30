"use strict";

const zlib = require('zlib');
const aws = require('aws-sdk');

const ddb = new aws.DynamoDB();

const eventUpdateRE = /\t#####EVENTUPDATE\[(([A-Za-z0-9\-_]+)\(([A-Za-z0-9\-_,.:/]*)\))]#####\n$/;

function createIngestionHandler (tableName, properties) {
    return async function (event) {
        const payload = new Buffer(event.awslogs.data, 'base64');

        let logBatch = JSON.parse(zlib.gunzipSync(payload).toString('ascii'));
        const logEvents = logBatch.logEvents;

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
                            "params": {SS: item.params},
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
            calls.push(ddb.batchWriteItem(params).promise());
        }

        return Promise.all(calls);

    };
}


module.exports.createIngestionHandler = createIngestionHandler;