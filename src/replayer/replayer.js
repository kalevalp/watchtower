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
    const response = responseRegistry[histEvent.idx];
    response.deferred.trigger();
    return response.resp;
}

function registerResponse(resp, deferred, idx) {
    responseRegistry[idx] = {resp, deferred};
};

function createPromiseProxy() {
    return () => {
        let curr = hist.shift();
        let next = hist[0];

        let response;

        if (next.idx === curr.idx) { // The next op is the response. Respond.
            response = Promise.resolve(eventHistory[curr.idx].item.data); // Stored response for this request.
        } else { // The next op is not the response. Need to register the response, and potentially trigger other responses.
            const deferred = defer();
            const value = eventHistory[curr.idx].item.data;
            response = deferred
                .then(() => value)

            registerResponse(response, deferred, curr.idx);

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
                                                    return createPromiseProxy();
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
	    }}),
    }


    let executionEnv = {
        console: 'inherit',
        sandbox: {
            process: process,
            Math : new Proxy(Math, {get: (target, p) => p==="random" ? () => getValueSync("Math.random") : target[p]}),
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
