"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const {PartialOrder} = require("po-utils");
const {TotalOrder} = require("to-utils");
const {auth} = require("auth");
const {SecureKV_PO} = require("secure-kv-po");
const {SecureKV_TO} = require("secure-kv-to");
const aws = require("aws-sdk");
const nodemailer = require("nodemailer");
const got = require('got');
const fetch = require('node-fetch');

const conf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const unsecuredLambda = fs.readFileSync(conf.unsecLambda, 'utf8');

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
                    externalEvent: strippedEvent,
                    externalContext: context,
                    externalCallback:
                        function (err, value) {
                            if (conf.runFromSF) { // Add label to the callback to the stepfunction, which in turn becomes the input to the next lambda.
                                if (value) {
                                    value.ifcLabel = label;
                                    value.callbackSecurityBound = callbackSecurityBound;
                                }
                                if (conf.declassifiers &&
                                    conf.declassifiers.callback &&
                                    labelOrdering.lte(label, conf.declassifiers.callback.maxLabel) &&
                                    labelOrdering.lte(conf.declassifiers.callback.minLabel, callbackSecurityBound)) {

                                    return callback(eval(conf.declassifiers.callback.errCode)(err), eval(conf.declassifiers.callback.valueCode)(value));
                                } else {
                                    return callback(err, value);
                                }
                            } else {
                                if (conf.declassifiers &&
                                    conf.declassifiers.callback &&
                                    labelOrdering.lte(label, conf.declassifiers.callback.maxLabel) &&
                                    labelOrdering.lte(conf.declassifiers.callback.minLabel, callbackSecurityBound)) {

                                    return callback(eval(conf.declassifiers.callback.errCode)(err),eval(conf.declassifiers.callback.valueCode)(value));

                                } else {
                                    if (labelOrdering.lte(label, callbackSecurityBound)) {
                                        return callback(err, value);
                                    } else {
                                        return callback(null);
                                    }
                                }
                            }
                        },
                    bumpLabelTo:
                        function (newLabel) {
                            if (labelOrdering.lte(label, newLabel)) {
                                labelHistory.push(label)
                                label = newLabel;
                                return true;
                            } else {
                                return false;
                            }
                        },
                    bumpLabelToTop:
                        function () {
                            label = this.bumpLabelTo(labelOrdering.getTop());
                        },
                    getCurrentLabel:
                        function () {
                            return label;
                        }
                },
                require: {
                    context: 'sandbox',
                    external: allowExtReq,
                    builtin: ['fs', 'url'],
                    root: "./",
                    mock: {
                        'kv-store': {
                            KV_Store: function (h, u, pwd, tableName) {
                                const skv = conf.usingPO ?
                                    new SecureKV_PO(conf.host, conf.user, conf.pass, labelOrdering, tableName) :
                                    new SecureKV_TO(conf.host, conf.user, conf.pass, tableName);

                                return {
                                    init: () => skv.init(),
                                    close: () => skv.close(),
                                    put: (k, v) => skv.put(k, v, label),
                                    get: (k) => {
                                        return skv.get(k, label)
                                            .then((res) => {
                                                if (res.length > 0) {
                                                    return res[0].rowvalues;
                                                } else {
                                                    return res;
                                                }
                                            }); // Arbitrary choice (?)
                                    },
                                    del: (k) => skv.del(k, label),
                                    keys: () => skv.keys(label),
                                    entries: () => skv.entries(label)
                                        .then(entries => {
                                            let filteredEntries = [];

                                            for (let entry of entries) {
                                                let entryMax = true;
                                                for (let compared of entries) {
                                                    if (entry.key === compared.key &&
                                                        entry.lab !== compared.lab &&
                                                        labelOrdering.lte(entry.lab, compared.lab)) {
                                                        entryMax = false;
                                                    }
                                                }
                                                if (entryMax) {
                                                    filteredEntries.push(entry);
                                                }
                                            }
                                            return filteredEntries;
                                        }),
                                }
                            }
                        },
                        'aws-sdk': {
                            config: aws.config,

                            Kinesis: function () {
                                const kinesis = new aws.Kinesis();
                                return {
                                    putRecord: (event, callback) => {
                                        const data = JSON.parse(event.Data);
                                        if (data.ifcLabel) { // && event.Data.ifcLabel !== label) {
                                            throw `Unexpected security label. Event written to kinesis should not have an ifcLabel field. Has label: ${data.ifcLabel}`;
                                        } else if (data.callbackSecurityBound) {
                                            throw `Unexpected security bound. Event written to kinesis should not have a callbackSecurityBound field. Has label: ${data.callbackSecurityBound}`;
                                        } else {
                                            data.ifcLabel = label;
                                            data.callbackSecurityBound = callbackSecurityBound;

                                            event.Data = JSON.stringify(data);
                                            return kinesis.putRecord(event, callback);
                                        }
                                    },
                                }
                            },

                            StepFunctions: function () {
                                const stepfunctions = new aws.StepFunctions();
                                return {
                                    startExecution: (params, callback) => {
                                        // Can add additional security measures here.
                                        // e.g. check the stream name against a valid stream name in the configuration.

                                        const transParams = params;
                                        const input = JSON.parse(params.input);
                                        input.ifcLabel = label;
                                        input.callbackSecurityBound = callbackSecurityBound;
                                        transParams.input = JSON.stringify(input);
                                        return stepfunctions.startExecution(transParams, callback);
                                    },
                                    getActivityTask: (params, callback) => stepfunctions.getActivityTask(params, callback),
                                    sendTaskFailure: (params, callback) => stepfunctions.sendTaskFailure(params, callback),
                                    sendTaskSuccess: (params, callback) => stepfunctions.sendTaskSuccess(params, callback),
                                }
                            },

                            Rekognition: function () {
                                const rek = new aws.Rekognition();
                                return rek;

                                // NOTE: Might want to uncomment this code, to secure outgoing call to rekognition.
                                // return {
                                //     detectLabels: function (params, callback) {
                                //         if (labelOrdering.lte(label, callbackSecurityBound)) {
                                //             return rek.detectLabels(params, callback);
                                //         } else {
                                //             return callback("Attempting to call detectLabels in violation with security policy");
                                //         }
                                //     }
                                // }
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


