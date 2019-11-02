"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require('aws-sdk');

const kinesis = new aws.Kinesis();

const debug   = process.env.DEBUG_WATCHTOWER;

function getRandString() {
    const sevenDigitID = Math.floor(Math.random() * Math.floor(9999999));
    return `${sevenDigitID}`;
}

let promisesToWaitFor = [];

/*
 * Expected logEvent format:
 *   {
 *     name: 'string',
 *     params: {
 *       <param_name>: <param_value>,
 *       ...
 *     }
 *   }
 */
function createEventPublisher(kinesisStreamName) {
    if (kinesisStreamName) {
        return (logEvent, lambdaContext) => {
            const params = {};
            const data = {};
            data.logEvent = logEvent;
            data.timestamp = Date.now();
            data.invocationID = lambdaContext.awsRequestId;
            params.StreamName = kinesisStreamName;
            // params.PartitionKey = lambdaContext.functionName;
            params.PartitionKey = lambdaContext.awsRequestId; // Preserves invocation locality, as well as scalability when app has a small number of function types.
            params.Data = JSON.stringify(data);

	    if (debug) console.log("Published event: ", JSON.stringify(params));

            promisesToWaitFor.push(kinesis.putRecord(params).promise());
        }
    } else {
        return (logEvent) => {
            console.log(`#####EVENTUPDATE${JSON.stringify(logEvent)}#####`);
        }
    }
}

function createBatchEventPublisher(kinesisStreamName) {
    if (kinesisStreamName) {
        return (logEvents, lambdaContext) => {
            const params = {};
            params.StreamName = kinesisStreamName;
            params.Records = logEvents.map(event => ({logEvent: event, 
                                                      timestamp: Date.now(),
                                                      invocationID: lambdaContext.awsRequestId}))
                .map(data => ({Data: JSON.stringify(data),
                               PartitionKey: `${lambdaContext.awsRequestId}${getRandString()}`}))
            
	    if (debug) console.log("Published batch event: ", JSON.stringify(params));
            
            promisesToWaitFor.push(kinesis.putRecords(params).promise());
        }
    } else {
        return (logEvent) => {
            console.log(`#####EVENTUPDATE${JSON.stringify(logEvent)}#####`);
        }
    }
}



function createRecordingHandler(originalLambdaFile, originalLambdaHandler, mock, runLocally, updateContext) {

    const originalLambdaPath    = `${runLocally?'':'/var/task/'}${originalLambdaFile}`;
    const originalLambdaCode    = fs.readFileSync(originalLambdaFile, 'utf8');
    const originalLambdaScript  = new VMScript(originalLambdaCode);

    let executionEnv = {
        console: 'inherit',
        sandbox: {
            process: process,
        },
        require: {
            context: 'sandbox',
            external: true,
            builtin: ['*'],
            // root: "./",
            mock: mock,
            // import: [], // Might be a useful optimization. Test at some point.
        },
    };

    const vm = new NodeVM(executionEnv);

    const vmExports = vm.run(originalLambdaScript, originalLambdaPath);

    if (updateContext) {
        return async (event, context) => {
            promisesToWaitFor = [];
            updateContext(originalLambdaHandler, event, context);
            const retVal = await vmExports[originalLambdaHandler](event, context);
            return Promise.all(promisesToWaitFor)
                .then(() => Promise.resolve(retVal));
        }
    } else {
        return vmExports[originalLambdaHandler];
    }
}

function recorderRequire(originalModuleFile, mock, runLocally) {

    const originalModulePath    = `${runLocally?'':'/var/task/'}${originalModuleFile}`;
    const originalModuleCode    = fs.readFileSync(originalModuleFile, 'utf8');
    const originalModuleScript  = new VMScript(originalModuleCode);

    let executionEnv = {
        console: 'inherit',
        sandbox: {
            process: process,
        },
        require: {
            context: 'sandbox',
            external: true,
            builtin: ['*'],
            // root: "./",
            mock: mock,
            // import: [], // Might be a useful optimization. Test at some point.
        },
    };

    const vm = new NodeVM(executionEnv);

    return vm.run(originalModuleScript, originalModulePath);
}

module.exports.createRecordingHandler = createRecordingHandler;
module.exports.createEventPublisher = createEventPublisher;
module.exports.recorderRequire = recorderRequire;
module.exports.createBatchEventPublisher = createBatchEventPublisher;
