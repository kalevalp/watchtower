"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const util = require('util');
const aws = require('aws-sdk');
const serialize = require('serialize-javascript');
const zlib = require('zlib');
const gzip = util.promisify(zlip.gzip);

const kinesis = new aws.Kinesis();

const debug   = process.env.DEBUG_WATCHTOWER;

let rnrRecording = false;
let rawRecorder = () => {};
let getLambdaContext = () => {};

function configureRNRRecording(enable, kinesisStreamName, s3BucketName, getContext) {
    rnrRecording = enable;
    if (enable) {
        rawRecorder = createRawRecorder(kinesisStreamName, s3BucketName);
        getLambdaContext = getContext;
    } else {
        rawRecorder = () => {};
        getLambdaContext = () => {};
    }
}

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
    if (debug) console.log("Creating event publisher. kinesisStreamName:", kinesisStreamName);
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

function createRawRecorder( kinesisStreamName, s3BucketName ) {
    return (logEvent) => {
        const now = Date.now();
        const lambdaContext = getLambdaContext();

        promisesToWaitFor.push(
            Promise.resolve( () => serialize({now, logEvent}, {unsafe: true}) )
                .then( ser => gzip(ser) )
                .then( zip => kinesis.putRecords({
                    StreamName: kinesisStreamName,
                    PartitionKey: lambdaContext.awsRequestId,
                    Data: zip,
                }).promise())
        );
    };
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
 *
 * We call the operation of the first condition matched.
 */
function awsPromiseProxyFactory(conditions) {
    return (underlyingObj) => new Proxy(underlyingObj, {
        apply: function (target, thisArg, argumentsList) {

            let call;

	    for (const cond of conditions) {
		if (cond.cond(target, thisArg, argumentsList)) {
		    if (debug) console.log("Running in aws-sdk 'promise' mode");
		    call = target.apply(thisArg, argumentsList)
			.on('success', (...resp) => {if (debug) console.log(`Running from within aws-sdk callback (pseudo-promise). resp is ${util.inspect(resp)}`)})
			.on('success', cond.opInSucc(argumentsList));

                    break;
		}
	    }

            if (!call)
                call = target.apply(thisArg, argumentsList);

            if (rnrRecording)
                call.on('complete', (resp) => rawRecorder(resp));

            return call;
        },
    });
}

function promiseProxyFactory(conditions) {
    return (underlyingObj) => new Proxy(underlyingObj, {
        apply: function (target, thisArg, argumentsList) {

            let call;

	    for (const cond of conditions) {
		if (cond.cond(target, thisArg, argumentsList)) {
		    if (debug) console.log("Running in promise mode");
		    call = target.apply(thisArg, argumentsList)
			.then(resp => {if (debug) console.log(`Running from within promise. resp is ${util.inspect(resp)}`); return resp;})
			.then(cond.opInSucc(argumentsList));

                    break;
		}
	    }

            if (!call)
                call = target.apply(thisArg, argumentsList);

            if (rnrRecording)
                call = call.then(resp => {rawRecorder(resp); return resp;});

            return call;
        },
    });
}

function cbackProxyFactory(conditions) {
    return (underlyingObj) => new Proxy(underlyingObj, {
        apply: function (target, thisArg, argumentsList) {
	    for (const cond of conditions) {
		if (cond.cond(target, thisArg, argumentsList)) {
		    if (debug) console.log("Running in callback mode");
		    // Assume last element of argumentsList is the callback function
		    const cbackIdx = argumentsList.length - 1;
		    const cbackFunc = argumentsList[cbackIdx];

		    if (typeof cbackFunc === 'function') {
			if (debug) console.log("Last arg in call is a function, assuming it is a callback and changing the callback function");
			argumentsList[cbackIdx] = (...args) => {
			    if (debug) console.log(`Running from within modified callback. args is: ${JSON.stringify(args)}`);
			    // assume standard callback format - args[0] === null/undefined => successful call
			    if (!args[0]) {
				if (debug) console.log("Calling the op.");
				cond.opInSucc(argumentsList)(...args);
				if (debug) console.log("Finished calling the op.");
			    }
			    if (debug) console.log("Calling the original callback");
			    return cbackFunc(...args);
			}
		    } // Otherwise, the callback here is not as expected. Falling back to doing nothing.

		    return target.apply(thisArg, argumentsList);
		}
	    }
	    return target.apply(thisArg, argumentsList);
        },
    });
};

function createDDBDocClientMock ( getProxyConditions,
				  putProxyConditions,
				  deleteProxyConditions,
				  queryProxyConditions,
				  useCallbacks = false ) {

    const proxies = [{name: 'get',    proxy: undefined, producer: useCallbacks ? cbackProxyFactory(getProxyConditions) : awsPromiseProxyFactory(getProxyConditions)},
		     {name: 'put',    proxy: undefined, producer: useCallbacks ? cbackProxyFactory(putProxyConditions) : awsPromiseProxyFactory(putProxyConditions)},
                     {name: 'delete', proxy: undefined, producer: useCallbacks ? cbackProxyFactory(deleteProxyConditions) : awsPromiseProxyFactory(deleteProxyConditions)},
                     {name: 'query',  proxy: undefined, producer: useCallbacks ? cbackProxyFactory(queryProxyConditions) : awsPromiseProxyFactory(queryProxyConditions)},
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
					    cond.opInSucc(argumentsList)();
					    break;
					}
				    }
				    if (debug) console.log("Twit.post: Are you mocking me? 'coz I feel like I'm being mocked!");
				}
			    });
			} else {
			    if (!proxy) {
				proxy = (useCallbacks ? cbackProxyFactory(proxyConditions) : promiseProxyFactory(proxyConditions))(obj[prop]);
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
			cond.opInSucc(argumentsList)();
			break;
		    }
		}
		if (debug) console.log("RP: Are you mocking me? 'coz I feel like I'm being mocked!");
	    }
	});
    } else {
	if (!proxy) {
            proxy = (useCallbacks ? cbackProxyFactory(proxyConditions) : promiseProxyFactory(proxyConditions))(rp);
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
		    proxy = promiseProxyFactory(proxyConditions)(obj[prop]);
		}
		return proxy;
	    } else {
		return obj[prop];
	    }
	}
    });
}

function createAWSSDKMock() {

    return new Proxy(aws, {
        get: function (obj, prop) {
            switch (prop) {
            case 'Kinesis':
                const kinesis = new aws.Kinesis();
                return {
                    putRecord: recordWrapperCallback(kinesis.putRecord, "aws-sdk.Kinesis.putRecord"),
                }
                break;
            case 'StepFunctions': // TODO
                const stepfunctions = new aws.StepFunctions();
                return {
                    startExecution: recordWrapperCallback(stepfunctions.startExecution, "aws-sdk.StepFunctions.startExecution"),
                    getActivityTask: recordWrapperCallback(stepfunctions.getActivityTask, "aws-sdk.StepFunctions.getActivityTask"),
                    sendTaskFailure: recordWrapperCallback(stepfunctions.sendTaskFailure, "aws-sdk.StepFunctions.sendTaskFailure"),
                    sendTaskSuccess: recordWrapperCallback(stepfunctions.sendTaskSuccess, "aws-sdk.StepFunctions.sendTaskSuccess"),
                }

                break;
            case 'Rekognition': // TODO
                const rek = new aws.Rekognition();
                return {
                    detectLabels: recordWrapperCallback((params, cb) => rek.detectLabels(params, cb), "aws-sdk.Rekognition.detectLabels"),
                }
                break;
            case 'S3':
                const s3 = new aws.S3();
                return new Proxy(obj[prop], {
                    get: (target, p) =>
                        p==="putObject" ? (params, callback) => {
                            params.Tagging = params.Tagging ? params.Tagging + "&" : "";

                            params.Tagging = params.Tagging + "execid=" + invocationID;

                            return recordWrapperCallback((params, cb) => s3.putObject(params, cb),"aws-sdk.s3.putobject")(params, callback);
                        } :
                    p==="getObject" ? recordWrapperCallback((params, cb) => s3.getObject(params, cb),"aws-sdk.S3.getObject") :
                        target[p]});
                break;
            case 'DynamoDB':
                const ddb = new aws.DynamoDB(options);
                return new Proxy(ddb, {
                    get: (target, p) =>
                        p==="putItem" ?
                        (params, callback) => {
                            params.Item.execId = invocationID;

                            return recordWrapperCallback((params, cb) => target.putItem(params, cb), "aws-sdk.dynamodb.putItem")(params, callback);
                        } :
                    p==="getItem" ?
                        (params, callback) => {
                            return recordWrapperCallback((ps, cb) => target.getItem(ps, cb))(params, callback)
                        } :
                    target[p]
                })
                break;
            default:
                return obj[prop];
            }
        }
    });
}

function createNodemailerMock() {
    const nm = require('nodemailer');

    return new proxy(nm, {
        get: function (obj, prop) {
            switch (prop) {
            case 'createTransport':
                return (params) => {
                    const mailer = nodemailer.createTransport(params);

                    return {
                        sendMail: recordWrapperPromise(mailer.sendMail, "nodemailer.sendMail"),
                    }
                }
                break;

            case 'getTestMessageUrl':
                return recordWrapperPromise(nodemailer.getTestMessageUrl,"nodemailer.getTestMessageUrl");
                break;

            default:
                return obj[prop];
            }
        }})
}

function createGotMock() {
    const got = require('got');

    return new Proxy(got, {
        get: function (object, prop) {
            switch (prop) {
            case 'get':
                return recordWrapperPromise(got.get, "got.get");
                break
            default:
                return obj[prop];
            }
        }
    });
}

function createNodeFetchMock() {
    const nf = require('node-fetch');

    return new Proxy (nf, {
	apply: function (target, thisArg, argumentsList) {

			.on('success', (...resp) => {if (debug) console.log(`Running from within aws-sdk callback (pseudo-promise). resp is ${util.inspect(resp)}`)})
			.on('success', cond.opInSucc(argumentsList));

                    break;
		}
	    }

            if (!call)
                call = target.apply(thisArg, argumentsList);

            if (rnrRecording)
                call.on('complete', (resp) => rawRecorder(resp));

            return call;
        },
    });
}

function promiseProxyFactory(conditions) {
    return (underlyingObj) => new Proxy(underlyingObj, {
        apply: function (target, thisArg, argumentsList) {

            let call;

	    for (const cond of conditions) {
		if (cond.cond(target, thisArg, argumentsList)) {
		    if (debug) console.log("Running in promise mode");
		    call = target.apply(thisArg, argumentsList)
			.then(resp => {if (debug) console.log(`Running from within promise. resp is ${util.inspect(resp)}`); return resp;})
			.then(cond.opInSucc(argumentsList));

                    break;
		}
	    }

            if (!call)
                call = target.apply(thisArg, argumentsList);

            if (rnrRecording)
                call = call.then(resp => {rawRecorder(resp); return resp;});

            return call;
        },
    });
}

function cbackProxyFactory(conditions) {
    return (underlyingObj) => new Proxy(underlyingObj, {
        apply: function (target, thisArg, argumentsList) {
	    for (const cond of conditions) {
		if (cond.cond(target, thisArg, argumentsList)) {
		    if (debug) console.log("Running in callback mode");
		    // Assume last element of argumentsList is the callback function
		    const cbackIdx = argumentsList.length - 1;
		    const cbackFunc = argumentsList[cbackIdx];

		    if (typeof cbackFunc === 'function') {
			if (debug) console.log("Last arg in call is a function, assuming it is a callback and changing the callback function");
			argumentsList[cbackIdx] = (...args) => {
			    if (debug) console.log(`Running from within modified callback. args is: ${JSON.stringify(args)}`);
			    // assume standard callback format - args[0] === null/undefined => successful call
			    if (!args[0]) {
				if (debug) console.log("Calling the op.");
				cond.opInSucc(argumentsList)(...args);
				if (debug) console.log("Finished calling the op.");
			    }
			    if (debug) console.log("Calling the original callback");
			    return cbackFunc(...args);
			}
		    } // Otherwise, the callback here is not as expected. Falling back to doing nothing.

		    return target.apply(thisArg, argumentsList);
		}
	    }
	    return target.apply(thisArg, argumentsList);
        },
    });
};

function createDDBDocClientMock ( getProxyConditions,
				  putProxyConditions,
				  deleteProxyConditions,
				  queryProxyConditions,
				  useCallbacks = false ) {

    const proxies = [{name: 'get',    proxy: undefined, producer: useCallbacks ? cbackProxyFactory(getProxyConditions) : awsPromiseProxyFactory(getProxyConditions)},
		     {name: 'put',    proxy: undefined, producer: useCallbacks ? cbackProxyFactory(putProxyConditions) : awsPromiseProxyFactory(putProxyConditions)},
                     {name: 'delete', proxy: undefined, producer: useCallbacks ? cbackProxyFactory(deleteProxyConditions) : awsPromiseProxyFactory(deleteProxyConditions)},
                     {name: 'query',  proxy: undefined, producer: useCallbacks ? cbackProxyFactory(queryProxyConditions) : awsPromiseProxyFactory(queryProxyConditions)},
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
					    cond.opInSucc(argumentsList)();
					    break;
					}
				    }
				    if (debug) console.log("Twit.post: Are you mocking me? 'coz I feel like I'm being mocked!");
				}
			    });
			} else {
			    if (!proxy) {
				proxy = (useCallbacks ? cbackProxyFactory(proxyConditions) : promiseProxyFactory(proxyConditions))(obj[prop]);
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
			cond.opInSucc(argumentsList)();
			break;
		    }
		}
		if (debug) console.log("RP: Are you mocking me? 'coz I feel like I'm being mocked!");
	    }
	});
    } else {
	if (!proxy) {
            proxy = (useCallbacks ? cbackProxyFactory(proxyConditions) : promiseProxyFactory(proxyConditions))(rp);
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
		    proxy = promiseProxyFactory(proxyConditions)(obj[prop]);
		}
		return proxy;
	    } else {
		return obj[prop];
	    }
	}
    });
}

function createAWSSDKMock() {
    return new Proxy(aws, {
        get: function (obj, prop) {
            switch (prop) {
            case 'Kinesis':
                return obj[prop];
                // const kinesis = new aws.Kinesis();
                // return {
                //     putRecord: recordWrapperCallback(kinesis.putRecord, "aws-sdk.Kinesis.putRecord"),
                // }
                break;
            case 'StepFunctions': // TODO
                return obj[prop];
                // const stepfunctions = new aws.StepFunctions();
                // return {
                //     startExecution: recordWrapperCallback(stepfunctions.startExecution, "aws-sdk.StepFunctions.startExecution"),
                //     getActivityTask: recordWrapperCallback(stepfunctions.getActivityTask, "aws-sdk.StepFunctions.getActivityTask"),
                //     sendTaskFailure: recordWrapperCallback(stepfunctions.sendTaskFailure, "aws-sdk.StepFunctions.sendTaskFailure"),
                //     sendTaskSuccess: recordWrapperCallback(stepfunctions.sendTaskSuccess, "aws-sdk.StepFunctions.sendTaskSuccess"),
                // }

                break;
            case 'Rekognition': // TODO
                return obj[prop];
                // const rek = new aws.Rekognition();
                // return {
                //     detectLabels: recordWrapperCallback((params, cb) => rek.detectLabels(params, cb), "aws-sdk.Rekognition.detectLabels"),
                // }
                break;
            case 'S3':
                return obj[prop];
                // const s3 = new aws.S3();
                // return new Proxy(obj[prop], {
                //     get: (target, p) =>
                //         p==="putObject" ? (params, callback) => {
                //             params.Tagging = params.Tagging ? params.Tagging + "&" : "";

                //             params.Tagging = params.Tagging + "execid=" + invocationID;

                //             return recordWrapperCallback((params, cb) => s3.putObject(params, cb),"aws-sdk.s3.putobject")(params, callback);
                //         } :
                //     p==="getObject" ? recordWrapperCallback((params, cb) => s3.getObject(params, cb),"aws-sdk.S3.getObject") :
                //         target[p]});
                break;
            case 'DynamoDB':
                return obj[prop];
                // const ddb = new aws.DynamoDB(options);
                // return new Proxy(ddb, {
                //     get: (target, p) =>
                //         p==="putItem" ?
                //         (params, callback) => {
                //             params.Item.execId = invocationID;

                //             return recordWrapperCallback((params, cb) => target.putItem(params, cb), "aws-sdk.dynamodb.putItem")(params, callback);
                //         } :
                //     p==="getItem" ?
                //         (params, callback) => {
                //             return recordWrapperCallback((ps, cb) => target.getItem(ps, cb))(params, callback)
                //         } :
                //     target[p]
                // })
                break;
            default:
                return obj[prop];
            }
        }
    });
}

function createNodemailerMock(proxyConditions, reallyMock = false) {
    const nm = require('nodemailer');

    return new proxy(nm, {
        get: function (obj, prop) {
            switch (prop) {
            case 'createTransport':
                return obj[prop];

                // return (params) => {
                //     const mailer = nodemailer.createTransport(params);

                //     return {
                //         sendMail: recordWrapperPromise(mailer.sendMail, "nodemailer.sendMail"),
                //     }
                // }
                break;

            case 'getTestMessageUrl':
                return obj[prop];
                // return recordWrapperPromise(nodemailer.getTestMessageUrl,"nodemailer.getTestMessageUrl");
                break;

            default:
                return obj[prop];
            }
        }})
}

function createGotMock(proxyConditions, reallyMock = false) {
    const got = require('got');
    let proxy;

    return new Proxy(got, {
        get: function (obj, prop) {
            switch (prop) {
            case 'get':
                if (!proxy) {
                    proxy = promiseProxyFactory(proxyConditions)(obj[prop]);
	        }

	        return proxy;
            default:
                return obj[prop];
            }
        }
    });
}

function createNodeFetchMock(proxyConditions, reallyMock = false) {
    const nf = require('node-fetch');
    let proxy;

    if (!proxy) {
        proxy = promiseProxyFactory(proxyConditions)(obj[prop]);
    }

    return proxy;


    return new Proxy (nf, {
	apply: function (target, thisArg, argumentsList) {
                            if (!proxy) {
                    proxy = promiseProxyFactory(proxyConditions)(obj[prop]);
	        }

	        return proxy;

            return target.apply(thisArg, argumentsList);
            // recordWrapperPromise(fetch, "node-fetch.fetch")
        }
    };
}


module.exports.createRecordingHandler = createRecordingHandler;
module.exports.createEventPublisher = createEventPublisher;
module.exports.recorderRequire = recorderRequire;
module.exports.createBatchEventPublisher = createBatchEventPublisher;
module.exports.createDDBDocClientMock = createDDBDocClientMock;
module.exports.createTwitMock = createTwitMock;
module.exports.createRPMock = createRPMock;
module.exports.createSendgridMailMock = createSendgridMailMock;
module.exports.configureRNRRecording = configureRNRRecording;

if (require.main === module) {
    const t = createTwitMock([{cond: () => true, opInSucc: () => console.log('Mocking!')}], true, true);
    const y = new t({consumer_key: '123', consumer_secret: '456', access_token: '789', access_token_secret: 'abc'});
    y.post();

    const r = createRPMock([{cond: () => true, opInSucc: () => console.log('Mocking!')}], false, true);
    r();

    const sgm = createSendgridMailMock();
    sgm.send();
};
