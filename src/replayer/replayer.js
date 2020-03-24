const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const util = require('util');

const aws = require('aws-sdk');
const li = require('lorem-ipsum');
// const serialize = require('serialize-javascript-w-cycles');
// const zlib = require('zlib');
// const gunzip = util.promisify(zlib.gunzip);

const kinesis = new aws.Kinesis();
const s3 = new aws.S3();

const debug = process.env.DEBUG_WATCHTOWER;

let eventHistory;
let responseRegistry;
let eventOrder;

function triggerResponse(histEvent) {
    const response = responseRegistry[histEvent.idx];
    response.deferred.trigger();
    return response.resp;
}

function registerResponse(resp, deferred, idx) {
    responseRegistry[idx] = {resp, deferred};
};

function createAWSPromiseProxy() {
    return () => ({
        promise: () => createPromiseProxy()
    })
}

function createPromiseProxy() {
    return () => {
        let curr = eventOrder.shift();

        if (curr.type !== 'CALL') throw "Expected call, got a response instead!";

        let next = eventOrder.shift();

        let response;

        if (next.idx === curr.idx) { // The next op is the response. Respond.
            response = Promise.resolve(eventHistory[curr.idx].item.data); // Stored response for this request.
        } else { // The next op is not the response. Need to register the response, and potentially trigger other responses.
            const deferred = defer();
            const value = eventHistory[curr.idx].item.data;
            response = deferred
                .then(() => value)

            registerResponse(response, deferred, curr.idx);

            while (eventOrder[0] &&
                   eventOrder[0].type === 'RESPONSE') {
                curr = next;
                next = eventOrder.shift();

                triggerResponse(curr);
            }
        }

        return response;
    }
}

function createSyncProxy() {
    return () => {
        let req = eventOrder.shift();
        let next = eventOrder.shift();

        // Recorded sync operations should always be followed by a response.

        if (next.idx !== req.idx) throw "FATAL ERROR! Recorded sync request not followed by a matching response."

        let response = eventHistory[req.idx].item.data; // Stored response for this request.

        return response;

    }
}

function defer() {
    let res, rej;

    const promise = new Promise((resolve, reject) => {
	res = resolve;
	rej = reject;
    });

    promise.resolve = res;
    promise.reject = rej;

    return promise;
}

function createReplayHandler(originalLambdaFile, originalLambdaHandler, useCallbacks = false) {

    const originalLambdaPath    = originalLambdaFile;
    const originalLambdaCode    = fs.readFileSync(originalLambdaFile, 'utf8');
    const originalLambdaScript  = new VMScript(`debugger;\n${originalLambdaCode}`);

    let eventHistory;

    const mock = {
        'aws-sdk': new Proxy(aws, {
	    get: function (obj, prop) {
                if (prop === "DynamoDB")
		    return new Proxy(obj[prop], {
                        get: function (obj, prop) {
			    if (prop === "DocumentClient")
                                return new Proxy(obj[prop], {
				    construct: function (target, args) {
                                        return new Proxy(new target(...args), {
					    get: function (obj, prop) {
                                                if (['get', 'put', 'delete', 'query'].includes(prop)) {
                                                    return createAWSPromiseProxy();
                                                } else {
                                                    return obj[prop];
                                                }
					    }
                                        });
				    },
                                });
			    else
                                return obj[prop];
                        }});
                else
		    return obj[prop];
	    }
        }),


        'lorem-ipsum': new Proxy(li, {
            get: function (obj, prop) {
                if (prop === 'LoremIpsum') {
                    return new Proxy(obj[prop], {
                        construct: function (target, args) {
                            return new Proxy(new target(...args), {
                                get: function (obj, prop) {
                                    if (prop === 'generateParagraphs') {
                                        return createSyncProxy();
                                        // console.log('*** huh ***');
                                    } else {
                                        return obj[prop];
                                    }
                                }
                            })
                        }
                    })
                }
            }
        }),


    }


    let executionEnv = {
        console: 'inherit',
        sandbox: {
            process: process,
            Math : new Proxy(Math, {get: (target, p) => p==="random" ? createSyncProxy() : target[p]}),
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

    eventHistory = await Promise.all(history.Contents
                             .map(item => item.Key)
                             .map(async Key => (
                                 {
                                     key: Key,
                                     item: JSON.parse(((await s3.getObject({Key, Bucket: s3BucketName}).promise()).Body.toString()))
                                 })))

    eventOrder = eventHistory.find(elem => elem.item.idx === 'opTO').item.data.operationTotalOrder;

    const eventTrigger = eventHistory.find(elem => elem.item.idx === 'event-context').item.data;


    eventHistory = eventHistory.reduce((acc, curr) => {acc[curr.item.idx] = curr; return acc}, {});

    if (handler) {
        handler.registerEventHistory(eventHistory);
        const result = await handler(eventTrigger.event, eventTrigger.context);

        return result;
    }
}

function replayCBackHandler(executionID, handler, s3BucketName) {
    // TODO
}

module.exports.replayAsyncHandler = replayAsyncHandler;
module.exports.createReplayHandler = createReplayHandler;

if (require.main === module) {
    const execId = process.argv[2];

    replayAsyncHandler(execId, undefined, 'wtrnrbucket');
}
