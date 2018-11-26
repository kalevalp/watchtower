const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();

function getEvents (collectedEvents, params) {
    return ddb.query(params).promise()
        .then(data => {
            if (data.LastEvaluatedKey) { // There are additional items in DynamoDB
                params.ExclusiveStartKey = data.LastEvaluatedKey;
                return getEvents(collectedEvents.concat(data.Items), params);
            } else {
                return collectedEvents.concat(data.Items)
            }
        })
}


module.exports.monitorFactory = (tableName, prop) => {
    return async function(event) {
        const instance = event.data.instantiatedVars;

        const ddbCalls = [];

        for (const proj of prop.projections) {
            let propinstKey = prop.name;

            for (const qvar of proj) {
                if (! instance[qvar]) {
                    throw `Instance is missing an assignment to quantified variable ${qvar}.`;
                }

                propinstKey+=qvar;
                propinstKey+=instance[qvar];
            }
            const queryRequest = {
                TableName: tableName,
                KeyConditionExpression: `propinst = :${propinstKey}`,
            };

            ddbCalls.push(getEvents([], queryRequest));
        }

        Promise.all(ddbCalls)
            .then(results => [].concat(...results)) // Return a single array consisting of all events.
            .then(results => results.sort((a, b) => a.timestamp === b.timestamp ? a.id - b.id : a.timestamp - b.timestamp)) // Sort by timestamp, with id being a tie-breakers
            .then(results => {
                let state = 'INITIAL';

                for (const e of results) {
                    const eventType       = e.type ;
                    // const eventId         = e.id ;
                    const eventParams     = e.params;
                    // const eventTimestamp  = e.timestamp;
                    // const eventLogGroup   = e.logGroup;
                    // const eventLogStream  = e.logStream;

                    if (prop.stateMachine[eventType]) {
                        // Make sure that the constants match

                        // Sanity check that the quantified variable assignment matches the current property instance

                        state = prop.stateMachine[eventType].to;

                        if (state === 'FAILURE') {
                            // Somehow report to the user that the property had been violated.
                        } else if (state === 'SUCCESS') {
                            // Terminate execution, and mark property so that it is not checked again.
                        }
                    }
                }
            })
    }

};