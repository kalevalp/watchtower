const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
const ses = new aws.SES();
const cwl = new aws.CloudWatchLogs();
const proputils = require('watchtower-property-utils');

const debug           = process.env.DEBUG_WATCHTOWER;
const eventTable      = process.env['WATCHTOWER_EVENT_TABLE'];
const checkpointTable = process.env['WATCHTOWER_CHECKPOINT_TABLE'];

const profile = process.env.PROFILE_WATCHTOWER;
const ingestionTimeOut = process.env.PROCESSING_LAMBDA_TIMEOUT;


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getEvents (collectedEvents, params) {
    if (debug) console.log("DDB call, getEvents: ", JSON.stringify(params));
    return ddb.query(params).promise()
        .then(data => {
            if (debug) console.log("DDB response, getEvents: ", JSON.stringify(data));
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
        if (debug) {
            console.log(JSON.stringify(event));
        }

        const monitorInstances = [];
        for (const record of event.Records) {
            let inst = JSON.parse(Buffer.from(record.kinesis.data,'base64').toString());

            monitorInstances.push(handleMonitorInstance(inst, record.kinesis.approximateArrivalTimestamp));
        }

        return Promise.all(monitorInstances)
    }
}

function updateInstanceStatus(instance, isDischarged, tableName, state, timestamp, eventID) {
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
                S: eventID
            },
        };
        params.UpdateExpression = "SET #ST = :status, #S = :state, #TS = :time, #EID = :eventid"
    }
    params.Key =  {"propinst" : {S : instance}};
    params.TableName = tableName;


    return ddb.updateItem(params).promise();
}

// Sort by timestamp, with id being a tie-breaker
function eventOrderComparator(a, b) {
    return a.timestamp === b.timestamp ? a.id - b.id : a.timestamp - b.timestamp;
}

function monitorFactory(prop) {
    if (debug) {
        console.log(JSON.stringify(prop));
    }

    return async function(instance, arrivalTimestamp) {
        const ddbCalls = [];

        // Check for a checkpoint
        // If terminated, delete event and finish run
        // Else, add checkpoint time-stamp to query
        // At the end of the run, write checkpoint, and delete processed events.

        const params = {
            Key: {"propinst": {S: proputils.getInstance(prop,instance)}},
            TableName: checkpointTable,
        };
        const checkpoint = await ddb.getItem(params).promise();

        function updateInstanceExpiration(e) {
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
                        N: Math.ceil(Date.now() / 1000) + 1, // Could go even safer and add lambda t/o instead of 1s.
                    },
                },
                UpdateExpression: "SET #TTL = :exp",
                TableName: eventTable,
            };
            return ddb.updateItem(params).promise();
        }

        if (checkpoint.Item &&
            checkpoint.Item.Status &&
            checkpoint.Item.Status.S === "DISCHARGED") {
            // received some terminating event after the property instance had been discharged. Need to do some GC.
            const eventTimestamp = checkpoint.Item.Timestamp.N;
            const queryParams = {
                TableName: eventTable,
                KeyConditionExpression: `propinst = :keyval`,
                ExpressionAttributeValues: {":keyval": {"S": `${proputils.getInstance(prop,instance)}`}},
                // TODO - add a timestamp filter.
            };

            const events = await getEvents([], queryParams);
            return Promise.all(events.filter(e => !e.Expiration).map(e => {
                return updateInstanceExpiration(e);
            }));
        }

        const preCallTimems = Date.now();
        const preCallTime = Math.ceil(Date.now()/1000);

        for (const proj of prop.projections) {

            let propinstKey = prop.name;

            for (const qvar of proj) {
                if (! instance[qvar]) {
                    console.log(`ERROR: Quantified variable ${qvar} not found in ${JSON.stringify(instance)}`);

                    throw `Instance is missing an assignment to quantified variable ${qvar}.`;
                }

                propinstKey+=qvar;
                propinstKey+=instance[qvar];
            }

            const queryRequest = {
                TableName: eventTable,
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
            .then(results => results.sort(eventOrderComparator))
            .then(async results => {
                if (debug) console.log("Events: ", JSON.stringify(results));
                if (debug) console.log("Events.timestamps: ", JSON.stringify(results.map(e => e.timestamp)));

                const stabilityTime = preCallTime - ingestionTimeOut - 1; // Assumes times are in seconds.

                if (debug) console.log("stabilityTime: ", stabilityTime);

                const stablePrefix = results.filter(e => Number(e.timestamp.N) < stabilityTime);
                const partialTail = results.filter(e => Number(e.timestamp.N) >= stabilityTime);

                if (debug) console.log("Stable prefix: ", JSON.stringify(stablePrefix));
                if (debug) console.log("Partial tail: ", JSON.stringify(partialTail));

                let state;
                let lastProcessedEvent;

                const stableIntermediateState = proputils.runProperty(prop, stablePrefix, instance);
                state = stableIntermediateState.state;
                lastProcessedEvent = stableIntermediateState.lastProcessedEvent;
                const partialExecutionState = proputils.runProperty(prop, partialTail, instance, state);
                state = partialExecutionState.state;
                lastProcessedEvent = partialExecutionState.lastProcessedEvent;

                let violationFalseAlarm = false;

                // Handling the state the FSM ended up in after processing all the events.
                if (state.curr === 'FAILURE') {
                    // Need to ensure that a violation had actually occured.
                    // There could have been a data race, where some events were not yet written to the DB when this checker started running.

                    // Step 1: Check if, given the violation, there exists an extension (within the eventual consistency windos) that does not lead to a violation.

                    const canHazExtenstion = proputils.hasNonViolatingExtension(prop, stablePrefix, partialTail, state.curr);

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
                            return cwl.filterLogEvents(params).promise();
                        }));

                        const actualMissing = missingEvents.map(event => processEvent(event)) // TODO
                            .filter(event => partialTail.every(partialEvent => partialEvent.uuid !== event.uuid));

                        const fullTail = partialTail.concat(actualMissing)
                            .sort(eventOrderComparator);

                        const actualRun = proputils.runProperty(prop, fullTail, stableIntermediateState.state);
                        if (actualRun.state !== 'FAILURE') {
                            violationFalseAlarm = true;
                        }

                        // Option 3: Delay rerun by delta
                    }

                    if (!violationFalseAlarm) {
                        // Report to the user that the property had been violated.
                        const params = {
                            Destination: { ToAddresses: [ 'mossie.torp@ethereal.email' ] },
                            Message: {
                                Body: { Text: { Data: `Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}` } },
                                Subject: { Data: `PROPERTY VIOLATION: ${prop.name}` }
                            },
                            Source: 'mossie.torp@ethereal.email',
                        };
                        await ses.sendEmail(params).promise();

                        let arrivalTimeText = '';

                        if (profile) {
                            arrivalTimeText = ` Kinesis arrival timestamp @@${arrivalTimestamp}@@.`
                        }

                        console.log(`Property ${prop.name} was violated for property instance ${JSON.stringify(instance)}. Failure triggered by event produced by Lambda invocation ${lastProcessedEvent.invocation.S}.${arrivalTimeText}`);
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
                if ((partialExecutionState.state in ['FAILURE', 'SUCCESS']) ||
                    (state.curr === 'FAILURE' &&
                        !violationFalseAlarm)){
                    // Mark instance as discharged
                    await updateInstanceStatus(proputils.getInstance(prop,instance), true, checkpointTable);
                } else {
                    // Checkpoint the stable part of the instance execution
                    const lastEvent = partialExecutionState.lastProcessedEvent;
                    await updateInstanceStatus(proputils.getInstance(prop,instance), false, checkpointTable, partialExecutionState.state.curr, lastEvent.timestamp.N, lastEvent.id.S);
                }

                // Mark TTL for all stable instance events (not projections).
                return Promise.all(stablePrefix.filter(e => e.propinst.S === proputils.getInstance(prop,instance)) // Removes projections
                    .map(e => updateInstanceExpiration(e)));
            })
            .catch((err) => console.log(err));
    }
}

module.exports.kinesisListenerFactory = kinesisListenerFactory;
module.exports.monitorFactory = monitorFactory;


if (process.argv[2] === "test") {
    const input = {
        "Records": [
            {
                "kinesis": {
                    "kinesisSchemaVersion": "1.0",
                    "partitionKey": "\"{\\\"eventid\\\":\\\"9b1596b2-4b34-46e9-84ba-cd742c5d49c1\\\"}\"",
                    "sequenceNumber": "49600642134495777700315066552915572419924899399074840626",
                    "data": "eyJldmVudGlkIjoiOWIxNTk2YjItNGIzNC00NmU5LTg0YmEtY2Q3NDJjNWQ0OWMxIn0=",
                    "approximateArrivalTimestamp": 1571654144.01
                },
                "eventSource": "aws:kinesis",
                "eventVersion": "1.0",
                "eventID": "shardId-000000000003:49600642134495777700315066552915572419924899399074840626",
                "eventName": "aws:kinesis:record",
                "invokeIdentityArn": "arn:aws:iam::432356059652:role/testEventReaderRole",
                "awsRegion": "eu-west-1",
                "eventSourceARN": "arn:aws:kinesis:eu-west-1:432356059652:stream/WatchtowertestInvocationStream"
            }
        ]
    };

    const property = {
        name: 'dummy',
        quantifiedVariables: ['eventid'],
        projections: [['eventid']],
        stateMachine: {
            'DUMMY_EVENT_TYPE_A': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'intermediate',
                },
                'intermediate': {
                    to: 'SUCCESS',
                },
            },
            'DUMMY_EVENT_TYPE_B': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'SUCCESS',
                },
                'intermediate': {
                    to: 'FAILURE',
                },
            },
        },
    };

    const handler = kinesisListenerFactory(monitorFactory(property));

    handler(input);
}