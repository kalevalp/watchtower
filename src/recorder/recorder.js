"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require("aws-sdk");
const nodemailer = require("nodemailer");
const got = require('got');
const fetch = require('node-fetch');

const conf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const unsecuredLambda = fs.readFileSync(conf.unsecLambda, 'utf8');


function recordWrapperCallback (call) {
    return (param, callback) => {
        console.log("#### Call log");
        console.log(JSON.stringify(param));
        console.log("#### END Call log");

        return call(param, (err, data) => {

            console.log("#### Response log");
            console.log(JSON.stringify(err));
            console.log(JSON.stringify(data));
            console.log("#### END Response log");

            callback(err, data)

        })
    }
}
function recordWrapperPromise (call) {
    return (param) => {
        console.log("#### Call log");
        console.log(JSON.stringify(param));
        console.log("#### END Call log");

        return call(param)
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

function recordWrapperPromiseTwoParams (call) {
    return (fst, snd) => {
        console.log("#### Call log");
        console.log(JSON.stringify(fst));
        console.log(JSON.stringify(snd));
        console.log("#### END Call log");

        return call(fst, snd)
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
${unsecuredLambda}
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
                            get: recordWrapperPromiseTwoParams(got.get),
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


