"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require("aws-sdk");
const nodemailer = require("nodemailer");
const got = require('got');
const fetch = require('node-fetch');

const conf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const unsecuredLambda = fs.readFileSync(conf.unsecLambda, 'utf8');


function recordWrapper (call) {
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
                                    putRecord: recordWrapper(kinesis.putRecord),
                                }
                            },

                            StepFunctions: function () {
                                const stepfunctions = new aws.StepFunctions();
                                return {
                                    startExecution: recordWrapper(stepfunctions.startExecution),
                                    getActivityTask: recordWrapper(stepfunctions.getActivityTask),
                                    sendTaskFailure: recordWrapper(stepfunctions.sendTaskFailure),
                                    sendTaskSuccess: recordWrapper(stepfunctions.sendTaskSuccess),
                                }
                            },

                            Rekognition: function () {
                                const rek = new aws.Rekognition();

                                return {
                                    detectLabels: recordWrapper(rek.detectLabels),
                                }
                            },
                        },
                        'nodemailer' : {
                            createTransport: (params) => {
                                const mailer = nodemailer.createTransport(params);

                                return {
                                    sendMail: (mailOptions) => {
                                        let nmSecLabel;
                                        if (conf.securityBounds &&
                                            conf.securityBounds.nodemailer) {
                                            nmSecLabel = conf.securityBounds.nodemailer;
                                        } else {
                                            nmSecLabel = "bottom";
                                        }
                                        if (conf.declassifiers &&
                                            conf.declassifiers.nodemailer &&
                                            labelOrdering.lte(label, conf.declassifiers.nodemailer.maxLabel) &&
                                            labelOrdering.lte(conf.declassifiers.nodemailer.minLabel, nmSecLabel)) {

                                            mailer.sendMail(eval(conf.declassifiers.nodemailer.code)(mailOptions));

                                        } else if (labelOrdering.lte(label, nmSecLabel)) {
                                            return mailer.sendMail(mailOptions);
                                        } else {
                                            throw "Attempting to send in violation with security policy"
                                        }

                                    }
                                }
                            },
                            getTestMessageUrl: (info) => nodemailer.getTestMessageUrl(info),
                        },
                        'got' : {
                            get: (uri, params) => {
                                let gotSecLabel;
                                if (conf.securityBounds &&
                                    conf.securityBounds.got) {
                                    gotSecLabel = conf.securityBounds.got;
                                } else {
                                    gotSecLabel = 'bottom';
                                }
                                if (conf.declassifiers &&
                                    conf.declassifiers.got &&
                                    labelOrdering.lte(label, conf.declassifiers.got.maxLabel) &&
                                    labelOrdering.lte(conf.declassifiers.got.minLabel, gotSecLabel)) {
                                    return got.get(eval(conf.declassifiers.got.uri)(uri), eval(conf.declassifiers.got.params)(params));
                                } else if (labelOrdering.lte(label, gotSecLabel)) {
                                    return got.get(uri, params);
                                } else {
                                    return Promise.reject("Attempting to access a url in violation with security policy");
                                }
                            }
                        },
                        'node-fetch' : (params) => {
                            let nodeFetchSecLabel;
                            if (conf.securityBounds &&
                                conf.securityBounds.nodeFetch) {
                                nodeFetchSecLabel = conf.securityBounds.nodeFetch;
                            } else {
                                nodeFetchSecLabel = 'bottom';
                            }
                            if (conf.declassifiers &&
                                conf.declassifiers.nodeFetch &&
                                labelOrdering.lte(label, conf.declassifiers.nodeFetch.maxLabel) &&
                                labelOrdering.lte(conf.declassifiers.nodeFetch.minLabel, nodeFetchSecLabel)) {
                                return fetch(eval(conf.declassifiers.nodeFetch.params)(params));
                            } else if (labelOrdering.lte(label, nodeFetchSecLabel)) {
                                return fetch(params);
                            } else {
                                return Promise.reject("Attempting to access a url in violation with security policy");
                            }
                        }
                    }
                },
            };

            const vm = new NodeVM(executionEnv);

            vm.run(originalLambdaScript, conf.secLambdaFullPath);

        };
    }
};


