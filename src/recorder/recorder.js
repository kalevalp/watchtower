"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require('aws-sdk');

const kinesis = new aws.Kinesis();

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
        return async (logEvent, lambdaContext) => {
            const params = {};
            const data = {};
            data.logEvent = logEvent;
            data.timestamp = Date.now();
            data.invocationID = lambdaContext.awsRequestId;
            params.StreamName = kinesisStreamName;
            params.PartitionKey = lambdaContext.functionName;
            params.Data = JSON.stringify(data);
            const res = await kinesis.putRecord(params).promise();
            return res;
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
        return (event, context) => {
            updateContext(originalLambdaHandler, event, context);
            return vmExports[originalLambdaHandler](event, context);
        }
    } else {
        return vmExports[originalLambdaHandler];
    }
}

module.exports.createRecordingHandler = createRecordingHandler;
module.exports.createEventPublisher = createEventPublisher;
