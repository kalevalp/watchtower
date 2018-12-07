const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
// const ses = new aws.SES();

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
    return function(instance) {
        const ddbCalls = [];

        for (const proj of prop.projections) {

            let propinstKey = prop.name;

            for (const qvar of proj) {
                if (! instance[qvar]) {
                    console.log(`ERROR: Quantified variable ${qvar} not fount in ${JSON.stringify(instance)}`);

                    throw `Instance is missing an assignment to quantified variable ${qvar}.`;
                }

                propinstKey+=qvar;
                propinstKey+=instance[qvar];
            }

            const queryRequest = {
                TableName: tableName,
                KeyConditionExpression: `propinst = :keyval`,
                ExpressionAttributeValues: {":keyval": {"S": `${propinstKey}`}},
            };

            ddbCalls.push(getEvents([], queryRequest));
        }

        return Promise.all(ddbCalls)
            .then(results => [].concat(...results)) // Return a single array consisting of all events.
            .then(results => results.sort((a, b) => a.timestamp === b.timestamp ? a.id - b.id : a.timestamp - b.timestamp)) // Sort by timestamp, with id being a tie-breaker
            .then(results => {
                let state = {
                    curr: 'INITIAL',
                    compound: prop.getNewCompoundState ? prop.getNewCompoundState() : {},
                };

                for (const e of results) {
                    const eventType = e.type.S;
                    const eventParams = e.params.L.map(param => param.S);

                    // TODO: Add check to sanity to ensure that if there's ANY, there's nothing else.
                    const transition =
                        prop.stateMachine[eventType]['ANY'] ?
                            prop.stateMachine[eventType]['ANY'] :
                            prop.stateMachine[eventType][state.curr];

                    if (transition) {
                        // Sanity check that the quantified variable assignment matches the current property instance
                        for (let i = 0; i < prop.stateMachine[eventType].params.length; i++) {
                            const varname = prop.stateMachine[eventType].params[i];

                            if (prop.quantifiedVariables.includes(varname)) { // This variable is used to determine the property instance

                                if (eventParams[i] !== instance[varname]) {
                                    throw "ERROR: Encountered an event whose parameters don't match the instance.";
                                }
                            }
                        }

                        let update;
                        let toState;

                        if (transition['GUARDED_TRANSITION']) {
                            const guardValuation = transition['GUARDED_TRANSITION'].guard(...eventParams);

                            if (guardValuation) {
                                update = transition['GUARDED_TRANSITION'].onGuardHolds.update;
                                toState = transition['GUARDED_TRANSITION'].onGuardHolds.to;

                            } else {
                                update = transition['GUARDED_TRANSITION'].onGuardViolated.update;
                                toState = transition['GUARDED_TRANSITION'].onGuardViolated.to;
                            }
                        } else {
                            update = transition.update;
                            toState = transition.to;
                        }
                        if (update)
                            update(state.compound, ...eventParams);

                        state.curr = toState;

                    }
                }

                // Handling the state the FSM ended up in after processing all the events.
                if (state.curr === 'FAILURE') {
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
                    console.log(`Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}`);
                } else if (state.curr === 'SUCCESS') {
                    // Terminate execution, and mark property so that it is not checked again.

                    console.log(`Property ${prop.name} holds for property instance ${JSON.stringify(instance)}`);
                } else {
                    // No violation found, but it might still be violated depending on future events.

                    console.log(`Property ${prop.name} was not violated (but might be violated by future events) for property instance ${JSON.stringify(instance)}`);
                }

            })
            .catch((err) => console.log(err));
    }
};