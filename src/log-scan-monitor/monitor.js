const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
// const ses = new aws.SES();

const constRE = /const__(.*$)/;
const varRE = /var__([a-zA-Z0-9_]+)/;



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

                    if (prop.stateMachine[eventType][state]) {
                        // Make sure that the constants match
                        let constsOk = true;
                        for (let i = 0; i < prop.stateMachine[eventType][state].params.length; i++) {
                            let constantsMatch = prop.stateMachine[eventType][state].params[i].match(constRE);
                            if (constantsMatch) {
                                const constantValue = constantsMatch[1];

                                if (constantValue !== eventParams[i]) {
                                    // This is not the event you're looking for
                                    constsOk = false;
                                }
                            }
                        }

                        // Sanity check that the quantified variable assignment matches the current property instance
                        let instanceOk = true;
                        for (let i = 0; i < prop.stateMachine[eventType][state].params.length; i++) {
                            const varnameMatch = prop.stateMachine[eventType][state].params[i].match(varRE);
                            if (varnameMatch) {
                                const varname = varnameMatch[1];
                                if (eventParams[i] !== instance[varname]) {
                                    // Maybe should throw an error of some kind. This should not happen, ever.
                                    instanceOk = false;
                                }
                            }
                        }

                        if (constsOk && instanceOk) {
                            state = prop.stateMachine[eventType][state].to;

                            if (state === 'FAILURE') {
                                // Somehow report to the user that the property had been violated.
                                // At the moment - fail. TODO: use AWS SES to send an email to someone.
                                // const params = {
                                //     Destination: { ToAddresses: [ 'alpernask@vmware.com' ] },
                                //     Message: {
                                //         Body: { Text: { Data: `Property ${prop.name} was violated for property instance ${instance}` } },
                                //         Subject: { Data: `PROPERTY VIOLATION: ${prop.name}` }
                                //     },
                                //     Source: 'alpernask@vmware.com',
                                // };
                                // return ses.sendEmail(params).promise();

                                // TODO: make a more readable print of the instance.
                                return `Property ${prop.name} was violated for property instance ${instance}`;
                            } else if (state === 'SUCCESS') {
                                // Terminate execution, and mark property so that it is not checked again.

                                return `Property ${prop.name} holds for property instance ${instance}`;
                            } else {
                                // No violation found, but it might still be violated depending on future events.

                                return `Property ${prop.name} was not violated (but might be violated by future events) for property instance ${instance}`;
                            }
                        }
                    }
                }
            })
    }
};