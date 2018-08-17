"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require("aws-sdk");
const nodemailer = require("nodemailer");
const got = require('got');
const fetch = require('node-fetch');

const conf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const originalLambda = fs.readFileSync(conf.originalLambda, 'utf8');


function recordWrapperSync (call) {
    return function () {
        console.log("#### Call log");
        console.log(JSON.stringify(arguments));
        console.log("#### END Call log");

        const res = call(...arguments);

        console.log("#### Result log");
        console.log(JSON.stringify(res));
        console.log("#### END Result log");

        return res;
    }
}

function recordWrapperCallback (call) {
    return function () {
        console.log("#### Call log");
        console.log(JSON.stringify(arguments)); // JSON.stringify returns a JSON representation of the object - i.e. no functions.
        console.log("#### END Call log");

        const cb = arguments[arguments.length-1];

        arguments[arguments.length-1] = (err, data) => {

            console.log("#### Response log");
            console.log(JSON.stringify(err));
            console.log(JSON.stringify(data));
            console.log("#### END Response log");

            cb(err, data)

        };

        return call(...arguments);
    }
}
function recordWrapperPromise (call) {
    return function () {
        console.log("#### Call log");
        console.log(JSON.stringify(arguments));
        console.log("#### END Call log");

        return call(...arguments)
            .then((data) => {

                console.log("#### Response log");
                console.log(JSON.stringify(data));
                console.log("#### END Response log");

                return data;
            })
            .catch((err) => {
                console.log("#### Error response log");
                console.log(JSON.stringify(err));
                console.log("#### END Error response log");

                return Promise.reject(err);
            });
    }
}

module.exports.makeShim = function (exp, allowExtReq) {
    for (let handlerName of conf.handlers) {
        const originalLambdaScript = new VMScript(`
//  ***********************************
//  ** Original Lambda Code:
${originalLambda}
//  ** End of Original Lambda Code:
//  ***********************************

module.exports.${handlerName}(externalEvent, externalContext, externalCallback);
        `);


        exp[handlerName] = function (event, context, callback) {

            const processEnv = {};
            for (let envVar of conf.processEnv) {
                processEnv[envVar] = process.env[envVar];
            }

            let executionEnv = {
                console: 'inherit',
                sandbox: {
                    process: {
                        env: processEnv,
                    },
                    externalEvent: event,
                    externalContext: context,
                    externalCallback: callback,
                    Math : new Proxy(Math, {get: (target, p) => p==="random" ? recordWrapperSync(Math.random()) : target[p]}),
                },
                require: {
                    context: 'sandbox',
                    external: allowExtReq,
                    builtin: ['fs', 'url'],
                    root: "./",
                    mock: {
                        'aws-sdk': {
                            config: aws.config,

                            Kinesis: function () {
                                const kinesis = new aws.Kinesis();
                                return {
                                    putRecord: recordWrapperCallback(kinesis.putRecord),
                                }
                            },

                            StepFunctions: function () {
                                const stepfunctions = new aws.StepFunctions();
                                return {
                                    startExecution: recordWrapperCallback(stepfunctions.startExecution),
                                    getActivityTask: recordWrapperCallback(stepfunctions.getActivityTask),
                                    sendTaskFailure: recordWrapperCallback(stepfunctions.sendTaskFailure),
                                    sendTaskSuccess: recordWrapperCallback(stepfunctions.sendTaskSuccess),
                                }
                            },

                            Rekognition: function () {
                                const rek = new aws.Rekognition();

                                return {
                                    detectLabels: recordWrapperCallback(rek.detectLabels),
                                }
                            },
                        },
                        'nodemailer' : {
                            createTransport: (params) => {
                                const mailer = nodemailer.createTransport(params);

                                return {
                                    sendMail: recordWrapperPromise(mailer.sendMail),
                                }
                            },
                            getTestMessageUrl: recordWrapperPromise(nodemailer.getTestMessageUrl),
                        },
                        'got' : {
                            get: recordWrapperPromise(got.get),
                        },
                        'node-fetch' : recordWrapperPromise(fetch)
                    }
                },
            };

            const vm = new NodeVM(executionEnv);

            vm.run(originalLambdaScript, conf.secLambdaFullPath);

        };
    }
};


