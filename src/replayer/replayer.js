const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const util = require('util');

const aws = require('aws-sdk');
// const serialize = require('serialize-javascript-w-cycles');
// const zlib = require('zlib');
// const gunzip = util.promisify(zlib.gunzip);

const kinesis = new aws.Kinesis();
const s3 = new aws.S3();

const debug = process.env.DEBUG_WATCHTOWER;

let hist;
let responseRegistry;

function triggerResponse(histEvent) {
    const response= responseRegistry[histEvent.idx];
    response.trigger();
}

function registerResponse(resp, idx) {
    responseRegistry[idx] = resp;
};

function createPromiseProxy() {
    return () => {
        let curr = hist.shift();
        let next = hist[0];

        let response;

        if (next.idx === curr.idx) { // The next op is the response. Respond.
            response = Promise.resolve(eventHistory[curr.idx].item.data); // Stored response for this request.
        } else { // The next op is not the response. Need to register the response, and potentially trigger other responses.
            response = new Promise(); // TODO

            registerResponse(response, curr.idx);

            while (next &&
                   next.type === 'RESPONSE') {
                let curr = hist.shift();
                let next = hist[0];

                triggerResponse(curr);
            }
        }

        return response;
    }
}

function createReplayHandler(originalLambdaFile, originalLambdaHandler, mock, updateContext, useCallbacks = false) {

    const originalLambdaPath    = originalLambdaFile;
    const originalLambdaCode    = fs.readFileSync(originalLambdaFile, 'utf8');
    const originalLambdaScript  = new VMScript(`debugger;\n${originalLambdaCode}`);

    let eventHistory;

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

    let handler;

    if (!useCallbacks) {
        handler = async (event, context) => {
            debugger;
            return vmExports[originalLambdaHandler](event, context);
        }
    } else {
	handler = (event, context, callback) => {
            debugger;
	    return vmExports[originalLambdaHandler](event, context, callback);
	}
    }

    handler.registerEventHistory = (eh) => eventHistory = eh;

    return handler;
}

async function replayAsyncHandler(executionID, handler, s3BucketName) {
    const history = await s3.listObjects({Bucket: s3BucketName, Prefix: executionID}).promise();

    // TODO - handle history larger than 1000 objects

    const hist = await Promise.all(history.Contents
                                   .map(item => item.Key)
                                   .map(async Key => (
                                       {
                                           key: Key,
                                           item: JSON.parse(((await s3.getObject({Key, Bucket: s3BucketName}).promise()).Body.toString()))
                                       })))

    const order = hist.find(elem => elem.item.idx === 'opTO').item.data.operationTotalOrder;

    const eventTrigger = hist.find(elem => elem.item.idx === 'event-context').item.data;

    // console.log(order.filter(elem => elem.type === 'RESPONSE').map(elem => hist.find(item => item.item.idx === elem.idx).item.data.request));


    // handler.registerEventHistory(order.filter(elem => elem.type === 'RESPONSE').map(elem => hist.find(item => item.item.idx === elem.idx)));

    // await handler(eventTrigger.event, eventTrigger.context);


}

function replayCBackHandler(executionID, handler, s3BucketName) {
    // TODO
}

module.exports.replayAsyncHandler = replayAsyncHandler;

if (require.main === module) {
    const execId = process.argv[2];

    replayAsyncHandler(execId,'','wtrnrbucket');
}
