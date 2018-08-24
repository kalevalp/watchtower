const aws = require("aws-sdk");

function recordValue(identifier, value) {
    console.log(`#### VALUE::${identifier} #####`);
    console.log(JSON.stringify(value));
    console.log(`#### ENDVALUE::${identifier} #####`);

}

const counter = {};

function getAndAdvanceCounter(identifier) {
    if (!counter[identifier]) {
        counter[identifier] = 0;
    }

    return counter[identifier]++;
}

function recordWrapperSync (call, identifier) {
    if (!identifier) {
        throw "In recordWrapperSync. Can't call recorder without identifier.";
    }
    return function () {
        const invocationCounter = getAndAdvanceCounter(identifier);
        recordValue(`CALL${identifier}${invocationCounter}`, arguments);

        const res = call(...arguments);

        recordValue(`RESULT${identifier}${invocationCounter}`, res);

        return res;
    }
}

function recordWrapperCallback (call, identifier) {
    if (!identifier) {
        throw "In recordWrapperCallback. Can't call recorder without identifier.";
    }
    return function () {
        const invocationCounter = getAndAdvanceCounter(identifier);
        recordValue(`CALL${identifier}${invocationCounter}`, arguments);

        const cb = arguments[arguments.length-1];

        arguments[arguments.length-1] = (err, data) => {

            recordValue(`CALLBACKRESPONSEERROR${identifier}${invocationCounter}`, err);
            recordValue(`CALLBACKRESPONSEDATA${identifier}${invocationCounter}`, data);

            cb(err, data)
        };

        return call(...arguments);
    }
}

function recordWrapperPromise (call, identifier) {
    if (!identifier) {
        throw "In recordWrapperPromise. Can't call recorder without identifier.";
    }
    return function () {

        const invocationCounter = getAndAdvanceCounter(identifier);
        recordValue(`CALL${identifier}${invocationCounter}`, arguments);

        return call(...arguments)
            .then((data) => {
                recordValue(`PROMISERESPONSETHEN${identifier}${invocationCounter}`, data);

                return data;
            })
            .catch((err) => {

                recordValue(`PROMISERESPONSEERROR${identifier}${invocationCounter}`, err);

                return Promise.reject(err);
            });
    }
}
const logMessages = [];

function getLogs(groupName, streamName, invocationID) {
    var cloudwatchlogs = new aws.CloudWatchLogs({region: "us-west-1"});

    var params = {
        logGroupName: groupName,
        logStreamNames: [streamName],
        filterPattern: `"${invocationID}"`,
    };

    return cloudwatchlogs.filterLogEvents(params)
        .promise()
        .then (data => {
            const messages = data.events.map(e => e.message);
            logMessages.push(...messages);
            return messages;
            // return messages.filter(m => m.match("#### [A-Z]*[A-Za-z\.]*[0-9]* ####"));
        })
        .catch(err => console.log(err, err.stack));
}

function getInvocationTuple(groupName, streamName, invocationID) {
    return getLogs(groupName, streamName, invocationID)
        .then( log => {
            const eventIdx = log.findIndex(m => m.match('#### EVENT ####'));
            const eventMessageString = log[eventIdx + 1];

            const eventString = eventMessageString.slice(eventMessageString.indexOf("\t{"));
            const event = JSON.parse(eventString);

            const contextIdx = log.findIndex(m => m.match('#### CONTEXT ####'));
            const contextMessageString = log[contextIdx + 1];

            const contextString = contextMessageString.slice(contextMessageString.indexOf("\t{"));
            const context = JSON.parse(contextString);

            return [event, context];
        });
}

function getRecordedValue(identifier) {
    const valueLogIdx = logMessages.findIndex(m => m.match(identifier));
    const valueMessageString = logMessages[valueLogIdx + 1];

    const tmpString = valueMessageString.slice(valueMessageString.indexOf("\t")+1);
    const valueString = tmpString.slice(tmpString.indexOf("\t")+1);

    return JSON.parse(valueString);

}

/**
 * This function assumes that the logMessages variable had already been populated.
 * It should only be called from within a promise context that succeeds the promise returned by getInvocationTuple.
 * @param identifier
 */
function getValueSync(identifier) {
    const invocationCounter = getAndAdvanceCounter(identifier);
    return getRecordedValue(`RESULT${identifier}${invocationCounter}`);

}

module.exports.recordWrapperSync = recordWrapperSync;
module.exports.recordWrapperCallback = recordWrapperCallback;
module.exports.recordWrapperPromise = recordWrapperPromise;

module.exports.getInvocationTuple = getInvocationTuple;
module.exports.getValueSync = getValueSync;

//
// debugger;
//
// const eventIdx = data.events.findIndex(e => e.message.indexOf('\t#### EVENT ####\n') > -1);
// const eventMessageString = data.events[eventIdx + 1].message;
//
// const eventString = eventMessageString.slice(eventMessageString.indexOf("\t{"));
// const event = JSON.parse(eventString);
//
// vmModule.runReplayed(event, {}, () => {});

// var params = {
//     logGroupName: '/aws/lambda/hello-world-recorded-dev-hello',
//     logStreamNames: ['2018/08/20/[$LATEST]f18b94a01da2400085ce026912702ec8'],
//     // filterPattern: 'START RequestId\\\:', // Doesn't work!!
//     // filterPattern: '"4cabcdff-"',
//     // filterPattern: '4cabcdff',
//     filterPattern: '"4cabcdff-a4ba-11e8-aaeb-d37728f6aa8f"',
//     // filterPattern: 'RequestId',
//     // filterPattern: 'START RequestId',
//     // filterPattern: 'START',
//     // filterPattern: '4cabcdff-a4ba-11e8-aaeb-d37728f6aa8f',
//     // endTime: 0,
//     // limit: 0,
//     // nextToken: 'STRING_VALUE',
//     // startFromHead: true || false,
//     // startTime: 0
// };
