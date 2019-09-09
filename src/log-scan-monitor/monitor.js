const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
const ses = new aws.SES();

const profile = process.env.PROFILE_WATCHTOWER;

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

function kinesisListenerFactory (handleMonitorInstance) {
    return (event) => {
        const monitorInstances = [];
        for (const record of event.Records) {
            let inst = JSON.parse(Buffer.from(record.kinesis.data,'base64').toString());

            monitorInstances.push(handleMonitorInstance(inst, record.kinesis.approximateArrivalTimestamp));
        }

        return Promise.all(monitorInstances)
    }
}

function updateInstanceStatus(isDischarged, tableName, state, timestamp, eventID) {
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
		S: "DISCHARGED"
	    }, 
	    ":state": {
	    	S: state
	    },
	    ":time": {
	    	N: timestamp
	    },
	    ":eventid": {
		N: eventID
	    },
	};
	params.UpdateExpression: "SET #ST = :status, #S = :state, #TS = :time, #EID = :eventid"
    }
    params.Key =  {"propinst" : {S : instance}};
    params.TableName = tableName;

    
    return ddb.updateItem(params).promise();
};

function monitorFactory(tableName, checkpointTableName, prop) {
    return function(instance, arrivalTimestamp) {
	
	
        const ddbCalls = [];

	// Check for a checkpoint
	// If terminated, delete event and finish run
	// Else, add checkpoint time-stamp to query
	// At the end of the run, write checkpoint, and delete processed events.
	
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
		
		let failingInvocation;

                for (const e of results) {
                    const eventType = e.type.S;
                    const eventParams = e.params ? e.params.L.map(param => param.S) : [];
		    const eventInvocationUuid = e.invocation.S;

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

			if (toState === 'FAILURE')
			    failingInvocation = eventInvocationUuid;
			
                    }
                }

                // Handling the state the FSM ended up in after processing all the events.
                if (state.curr === 'FAILURE') {
                    // Report to the user that the property had been violated.
                    const params = {
                        Destination: { ToAddresses: [ 'mossie.torp@ethereal.email' ] },
                        Message: {
                            Body: { Text: { Data: `Property ${prop.name} was violated for property instance ${instance}` } },
                            Subject: { Data: `PROPERTY VIOLATION: ${prop.name}` }
                        },
                        Source: 'mossie.torp@ethereal.email',
                    };
                    await ses.sendEmail(params).promise();

		    let arrivalTimeText = '';

		    if (profile) {
			arrivalTimeText = ` Kinesis arrival timestamp @@${arrivalTimestamp}@@.`
		    }
		    
                    // TODO: make a more readable print of the instance.
                    console.log(`Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}. Failure triggered by event produced by Lambda invocation ${failingInvocation}.${arrivalTimeText}`);
		    
                } else if (state.curr === 'SUCCESS') {
                    // Terminate execution, and mark property so that it is not checked again.

                    console.log(`Property ${prop.name} holds for property instance ${JSON.stringify(instance)}`);
                } else {
                    // No violation found, but it might still be violated depending on future events.

                    console.log(`Property ${prop.name} was not violated (but might be violated by future events) for property instance ${JSON.stringify(instance)}`);
                }
		
		// GC
		if (state.curr in ['SUCCESS', 'FAILURE']) {
		    // Mark instance as discharged
		    await updateInstanceStatus(true, checkpointTableName);    
		    
		    // Mark TTL for all instance events (not projections).
		    return Promise.all(results.filter(e => e.propinst.S === instance) // Removes projections
				       .map(e => {
					   const params = {
					       Key: {
						   e.propinst,
						   e.uuid,
					       },
					       ExpressionAttributeNames: {
						   "#TTL": "Expiration"
					       },
					       ExpressionAttributeValues: {
						   ":exp": {
						       N: Math.ceil(Date.now()/1000) + 1, // Could go even safer and add lambda t/o instead of 1s.						      
						   },
					       },
					       UpdateExpression: "SET #TTL = :exp",
					       TableName: tableName,

					   }
					   return ddb.updateItem(params).promise();
				       }));
		}
		

            })
            .catch((err) => console.log(err));
    }
};

module.exports.kinesisListenerFactory = kinesisListenerFactory;
module.exports.monitorFactory = monitorFactory;

