"use strict";

const zlib = require('zlib');
const aws = require('aws-sdk');

const ddb = new aws.DynamoDB();

const eventUpdateRE = /\t#####EVENTUPDATE\[(([A-Za-z0-9\-_]+)\(([A-Za-z0-9\-_,.:/]*)\))]#####\n$/;

function createIngestionHandler (tableName) {
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
                const entry = {
                    type: eventType, // Partition Key
                    id: logEvent.id.toString(), // Sort Key
                    params: eventParams,
                    timestamp: logEvent.timestamp.toString(),
                    logGroup: logBatch.logGroup,
                    logStream: logBatch.logStream,
                };
                entries.push(entry);
            }
        }

        const batchedEntries = [];

        for (let i = 0; i < entries.length; i += 25) {
            batchedEntries.push(entries.slice(i, i + 25));
        }

        console.log(batchedEntries);

        const calls = [];

        for (const batch of batchedEntries) {

            const params = {};

            params.RequestItems = {};
            params.RequestItems[tableName] = [];


            for (const item of batch) {
                const putRequest = {
                    PutRequest: {
                        Item: {
                            "type": {S: item.type},
                            "id": {S: item.id},
                            "params": {SS: item.params},
                            "timestamp": {N: item.timestamp},
                            "logGroup": {S: item.logGroup},
                            "logStream": {S: item.logStream},
                        }
                    }
                };
                params.RequestItems[tableName].push(putRequest);
            }
            calls.push(ddb.batchWriteItem(params).promise());
        }

        return Promise.all(calls);

    };
}


module.exports.createIngestionHandler = createIngestionHandler;