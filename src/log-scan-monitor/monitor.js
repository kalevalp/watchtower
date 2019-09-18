const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
const ses = new aws.SES();
const cwl = new aws.CloudWatchLogs();
const proputils = require('watchtower-property-utils');


const profile = process.env.PROFILE_WATCHTOWER;
const ingestionTimeOut = process.env.PROCESSING_LAMBDA_TIMEOUT;

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
                S: "ACTIVE"
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
        params.UpdateExpression = "SET #ST = :status, #S = :state, #TS = :time, #EID = :eventid"
    }
    params.Key =  {"propinst" : {S : instance}};
    params.TableName = tableName;


    return ddb.updateItem(params).promise();
}

function monitorFactory(tableName, checkpointTableName, prop) {
    return async function(instance, arrivalTimestamp) {


        const ddbCalls = [];

        // Check for a checkpoint
        // If terminated, delete event and finish run
        // Else, add checkpoint time-stamp to query
        // At the end of the run, write checkpoint, and delete processed events.

        const params = {
            Key: {"propinst": {S: instance}},
            TableName: {checkpointTableName},
        };
        const checkpoint = await ddb.getItem(params).promise();
        if (checkpoint.Item &&
            checkpoint.Item.Status &&
            checkpoint.Item.Status.S === "DISCHARGED") {
            // received some terminating event after the property instance had been discharged. Need to do some GC.
            const eventTimestamp = checkpoint.Item.Timestamp.N;
            const queryParams = {
                TableName: tableName,
                KeyConditionExpression: `propinst = :keyval`,
                ExpressionAttributeValues: {":keyval": {"S": `${instance}`}}, // TODO - Need to properly format the key. Also, go over other uses of instance and make sure they're correct!
                // TODO - add a timestamp filter.
            };

            const events = await getEvents([], queryParams);
            // TODO - refactor
            return Promise.all(events.filter(e => !e.Expiration).map(e => {
                const params = {
                    Key: {
                        propinst: e.propinst,
                        uid: e.uuid, // TODO - double-check the field name. Also in other instance of this code.
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

                };
                return ddb.updateItem(params).promise();
            }));
        }

        const preCallTimems = Date.now();
        const preCallTime = Math.ceil(Date.now()/1000);

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

            if (checkpoint.Items &&
                checkpoint.Items.Status &&
                checkpoint.Item.Status.S === "ACTIVE") {
                // Property is active and had been previously checkpointed. Need to start from the checkpoint.
                const eventTimestamp = checkpoint.Item.Timestamp.N;
                queryRequest.ExpressionAttributeValues[":ts"] = {"N": eventTimestamp};
                queryRequest.FilterExpression = "Timestamp > :ts" // TODO - add to filter a check for the existence of the ttl field.
            }

            ddbCalls.push(getEvents([], queryRequest));
        }

        return Promise.all(ddbCalls)
            .then(results => [].concat(...results)) // Return a single array consisting of all events.
            .then(results => results.sort((a, b) => a.timestamp === b.timestamp ? a.id - b.id : a.timestamp - b.timestamp)) // Sort by timestamp, with id being a tie-breaker
            .then(async results => {
                let {state, lastProcessedEvent} = proputils.runProperty(prop, results);

                // Handling the state the FSM ended up in after processing all the events.
                if (state.curr === 'FAILURE') {
                    // Need to ensure that a violation had actually occured.
                    // There could have been a data race, where some events were not yet written to the DB when this checker started running.

                    // Step 1: Check if, given the violation, there exists an extension (within the eventual consistency windos) that does not lead to a violation.
                    const stabilityTime = preCallTime - ingestionTimeOut - 1; // Assumes times are in seconds.
                    const stablePrefix = results.filter(e => e.timestamp < stabilityTime);
                    const partialTail = results.filter(e => e.timestamp >= stabilityTime);

                    let violationFalseAlarm = false;

                    const canHazExtenstion = hasNonViolatingExtension(property, stablePrefix, partialTail, state.curr);

                    // Step 2: Read the log and see if there might have been any other events during that time-period.
                    if (canHazExtenstion) {
                        // Read log.
                        // Option 1: CWL Insight query.

                        // Option 2: CWL filter call (per log group(!))
                        const missingEvents = await Promise.all(logGroups.map(lg => {
                            const params = {
                                logGroupName: lg,
                                startTime: 'NUMBER_VALUE',
                                endTime: 'NUMBER_VALUE',
                                filterPattern: 'STRING_VALUE',
                            };
                            return cloudwatchlogs.filterLogEvents(params).promise();
                        }));

                        missingEvents.map(event => processEvent(event))
                            .filter(event => actuallyMissing(event));

                        if (checkProperty(property, stablePrefix :: fullTail)) {
                            violationFalseAlarm = true;
                        }

                        // Option 3: Delay rerun by delta
                    }

                    if (!violationFalseAlarm) {
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
                    }
                } else if (state.curr === 'SUCCESS') {
                    // Terminate execution, and mark property so that it is not checked again.

                    console.log(`Property ${prop.name} holds for property instance ${JSON.stringify(instance)}`);
                } else {
                    // No violation found, but it might still be violated depending on future events.

                    console.log(`Property ${prop.name} was not violated (but might be violated by future events) for property instance ${JSON.stringify(instance)}`);
                }

                // GC
                // TODO - GC is actually a little problematic, need to only GC up to stable point. Consider rewriting the entire to checker to split it into two parts, stable check and unstable check.
                if (state.curr in ['SUCCESS', 'FAILURE']) {
                    // Mark instance as discharged
                    await updateInstanceStatus(true, checkpointTableName);
                } else {
                    // Checkpoint the instance
                    const lastEvent = results[results.length - 1];
                    await updateInstanceStatus(false, checkpointTableName, state.curr, lastEvent.timestamp.N, lastEvent.id.S);
                }

                // Mark TTL for all instance events (not projections).
                return Promise.all(results.filter(e => e.propinst.S === instance) // Removes projections
                    .map(e => {
                        const params = {
                            Key: {
                                propinst: e.propinst,
                                uuid: e.uuid,
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
                        };
                        return ddb.updateItem(params).promise();
                    }));


            })
            .catch((err) => console.log(err));
    }
}

module.exports.kinesisListenerFactory = kinesisListenerFactory;
module.exports.monitorFactory = monitorFactory;
