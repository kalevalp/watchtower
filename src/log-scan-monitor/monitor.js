const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();

const propertyInstances = {};

function getEvents (collectedEvents, params) {
    return ddb.query(params).promise()
        .then(data => {
            if (data.LastEvaluatedKey) {
                params.ExclusiveStartKey = data.LastEvaluatedKey;
                return getEvents(collectedEvents.concat(data.Items), params)
            } else {
                return collectedEvents.concat(data.Items)
            }
        })
}


module.exports.monitorFactory = (instantiateProperty) => {

    return async function(event, context) {

        const ddbCalls = [];

        for (const event of events) {
            const queryRequest = {
                TableName: process.env.EVENTS_TABLE,
                KeyConditionExpression: `type = :${event}`,
            };

            ddbCalls.push(getEvents([], queryRequest));
        }

        Promise.all(ddbCalls)
            .then(results => [].concat(...results)) // Return a single array consisting of all events.
            .then(results => results.sort((a, b) => a.timestamp - b.timestamp)) // Sort by timestamp
            .then(results => {
                for (let i = 0; i < results.length - 1; i++) {
                    if (results[i].timestamp === results[i+1].timestamp) {
                        // TODO: Handle potential race
                    }
                }
                return results;
            }) // Check for potential races
            .then(results => {
                for (const e of results) {
                    const eventType       = e.type ;
                    // const eventId         = e.id ;
                    const eventParams     = e.params;
                    // const eventTimestamp  = e.timestamp;
                    // const eventLogGroup   = e.logGroup;
                    // const eventLogStream  = e.logStream;

                    if (!propertyInstances[eventParams]) {
                        propertyInstances[eventParams] = instantiateProperty(...eventParams);
                    }

                    propertyInstances[eventParams](eventType);
                }
            })
    }

};