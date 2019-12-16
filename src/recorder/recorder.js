"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const util = require('util');
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



function createRecordingHandler(originalLambdaFile, originalLambdaHandler, mock, runLocally, updateContext, useCallbacks = false) {

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

    if (!useCallbacks) {
        return async (event, context) => {
            promisesToWaitFor = [];
            updateContext(originalLambdaHandler, event, context);
            const retVal = await vmExports[originalLambdaHandler](event, context);
            return Promise.all(promisesToWaitFor)
                .then(() => Promise.resolve(retVal));
        }
    } else {
	return (event, context, callback) => {
	    promisesToWaitFor = [];
	    updateContext(originalLambdaHandler, event, context);
	    return vmExports[originalLambdaHandler](event, context, (err, success) => {
		return Promise.all(promisesToWaitFor)
		    .then(() => callback(err, success),
			  (errVal) => callback(errVal));
	    });
	}
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

/**
 * Proxy Conditions:
 *  [
 *   {cond: () -> Bool, opInSucc: () -> () -> ()}
 *  ]
 */

function proxyFactory(conditions, useCallbacks = false) {
    return (underlyingObj) => new Proxy(underlyingObj, {
        apply: function (target, thisArg, argumentsList) {
	    for (const cond of conditions) {
		if (cond.cond(target, thisArg, argumentsList)) {
		    if (!useCallbacks) {
			if (debug) console.log("Running in promise mode");
			return target.apply(thisArg, argumentsList)
			    .on('success', (...resp) => {if (debug) console.log(`Running from within promise. resp is ${util.inspect(resp)}`)})
			    .on('success', cond.opInSucc(argumentsList));
		    } else {
			if (debug) console.log("Running in callback mode");
			// Assume last element of argumentsList is the callback function
			const cbackIdx = argumentsList.length - 1;
			const cbackFunc = argumentsList[cbackIdx];

			if (typeof cbackFunc === 'function') {
			    if (debug) console.log("Last arg in call is a function, assuming it is a callback and changing the callback function");
			    argumentsList[cbackIdx] = (...args) => {
				if (debug) console.log(`Running from within modified callback.`);
				if (debug) console.log(`args is: ${JSON.stringify(args)}`);
				// assume standard callback format - args[0] === null/undefined => successful call
				if (!args[0]) {
				    if (debug) console.log("Calling the op.");
				    cond.opInSucc(argumentsList);
				    if (debug) console.log("Finished calling the op.");
				}
				if (debug) console.log("Calling the original callback");
				return cbackFunc(...args);
			    }
			} // Otherwise, the callback here is not as expected. Falling back to doing nothing.

			return target.apply(thisArg, argumentsList);
		    }
		}
	    }
	    return target.apply(thisArg, argumentsList);
        },
    });
}

function createDDBDocClientMock ( getProxyConditions,
				  putProxyConditions,
				  deleteProxyConditions,
				  queryProxyConditions,
				  useCallbacks = false ) {

    const proxies = [{name: 'get',    proxy: undefined, producer: proxyFactory(getProxyConditions, useCallbacks)},
		     {name: 'put',    proxy: undefined, producer: proxyFactory(putProxyConditions, useCallbacks)},
		     {name: 'delete', proxy: undefined, producer: proxyFactory(deleteProxyConditions, useCallbacks)},
		     {name: 'query',  proxy: undefined, producer: proxyFactory(queryProxyConditions, useCallbacks)},
		    ];

    return new Proxy(aws, {
	get: function (obj, prop) {
            if (prop === "DynamoDB")
		return new Proxy(obj[prop], {
                    get: function (obj, prop) {
			if (prop === "DocumentClient")
                            return new Proxy(obj[prop], {
				construct: function (target, args) {
                                    return new Proxy(new target(...args), {
					get: function (obj, prop) {
					    for (const prx of proxies) {
						if (prop === prx.name) {
						    if (!prx.proxy) {
							prx.proxy = prx.producer(obj[prop]);
						    }
						    return prx.proxy;
						}
					    }
					    return obj[prop];
					}
                                    });
				},
                            });
			else
                            return obj[prop];
                    }});
            else
		return obj[prop];
	}})
}

function createTwitMock(proxyConditions, useCallbacks = true, reallyMock = false) {
    const twit = require('twit');

    let proxy;

    return new Proxy(twit, {
	construct: function (target, args) {
	    if (debug) console.log("In construct:", target, args);
	    return new Proxy(new target(...args), {
		get: function (obj, prop) {
		    if (debug) console.log("In get:", obj, prop);
		    if (prop === "post") {
			if (reallyMock) {
			    return new Proxy (() => {}, {
				apply: function (target, thisArg, argumentsList) {
				    for (const cond of proxyConditions) {
					if (cond.cond(target, thisArg, argumentsList)) {
					    cond.opInSucc(argumentsList);
					    break;
					}
				    }
				    if (debug) console.log("Twit.post: Are you mocking me? 'coz I feel like I'm being mocked!");
				}
			    });
			} else {
			    if (!proxy) {
				proxy = proxyFactory(proxyConditions, useCallbacks)(twit);
			    }
			    return proxy;
			}
		    } else {
			return obj[prop];
		    }
		}
	    });
	},
    });
}

function createRPMock(proxyConditions, useCallbacks = false, reallyMock = false) {
    debugger;
    const rp = require('request-promise');
    let proxy;

    if (reallyMock) {
	return new Proxy(rp, {
	    apply: function (target, thisArg, argumentsList) {
		for (const cond of proxyConditions) {
		    if (cond.cond(target, thisArg, argumentsList)) {
			cond.opInSucc(argumentsList);
			break;
		    }
		}
		if (debug) console.log("RP: Are you mocking me? 'coz I feel like I'm being mocked!");
	    }
	});
    } else {
	if (!proxy) {
	    proxy = proxyFactory(proxyConditions, useCallbacks)(rp);
	}
	return proxy;
    }
}

function createSendgridMailMock(proxyConditions) {
    const sgMail = require('@sendgrid/mail');

    let proxy;
    return new Proxy(sgMail, {
	get: function (obj, prop) {
	    if (debug) console.log("In get:", obj, prop);
	    if (prop === "send") {
		if (!proxy) {
		    proxy = proxyFactory(proxyConditions)(obj[prop]);
		}
		return proxy;
	    } else {
		return obj[prop];
	    }
	}
    });
}

module.exports.createRecordingHandler = createRecordingHandler;
module.exports.createEventPublisher = createEventPublisher;
module.exports.recorderRequire = recorderRequire;
module.exports.createBatchEventPublisher = createBatchEventPublisher;
module.exports.createDDBDocClientMock = createDDBDocClientMock;
module.exports.createTwitMock = createTwitMock;
module.exports.createRPMock = createRPMock;
module.exports.createSendgridMailMock = createSendgridMailMock;

if (require.main === module) {
    const t = createTwitMock([{cond: () => true, opInSucc: () => console.log('Mocking!')}], true, true);
    const y = new t({consumer_key: '123', consumer_secret: '456', access_token: '789', access_token_secret: 'abc'});
    y.post();

    const r = createRPMock([{cond: () => true, opInSucc: () => console.log('Mocking!')}], false, true);
    r();

    const sgm = createSendgridMailMock();
    sgm.send();
};
