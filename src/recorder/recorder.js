"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require("aws-sdk");
const nodemailer = require("nodemailer");
const got = require('got');
const fetch = require('node-fetch');
const {recordWrapperSync, recordWrapperCallback, recordWrapperPromise, flushCounters} = require("rnr-utils");

const conf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const originalLambda = fs.readFileSync(conf.originalLambda, 'utf8');

const originalLambdaScript = new VMScript(`
//  ***********************************
//  ** Original Lambda Code:
${originalLambda}
//  ** End of Original Lambda Code:
//  ***********************************
        `);


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
        // externalEvent: event,
        // externalContext: context,
        // externalCallback: callback,
        Math : new Proxy(Math, {get: (target, p) => p==="random" ? recordWrapperSync(Math.random,"Math.random") : target[p]}),
    },
    require: {
        context: 'sandbox',
        external: true,
        builtin: ['*'],
        root: "./",
        mock: {
            'aws-sdk': {
                config: aws.config,

                Kinesis: function () {
                    const kinesis = new aws.Kinesis();
                    return {
                        putRecord: recordWrapperCallback(kinesis.putRecord, "aws-sdk.Kinesis.putRecord"),
                    }
                },

                StepFunctions: function () {
                    const stepfunctions = new aws.StepFunctions();
                    return {
                        startExecution: recordWrapperCallback(stepfunctions.startExecution, "aws-sdk.StepFunctions.startExecution"),
                        getActivityTask: recordWrapperCallback(stepfunctions.getActivityTask, "aws-sdk.StepFunctions.getActivityTask"),
                        sendTaskFailure: recordWrapperCallback(stepfunctions.sendTaskFailure, "aws-sdk.StepFunctions.sendTaskFailure"),
                        sendTaskSuccess: recordWrapperCallback(stepfunctions.sendTaskSuccess, "aws-sdk.StepFunctions.sendTaskSuccess"),
                    }
                },

                Rekognition: function () {
                    const rek = new aws.Rekognition();

                    return {
                        detectLabels: recordWrapperCallback((params, cb) => rek.detectLabels(params, cb), "aws-sdk.Rekognition.detectLabels"),
                    }
                },
                S3: function () {
                    const s3 = new aws.S3();
                    return new Proxy(s3, {get: (target, p) =>
                            p==="putObject" ? (params, callback) => {
                                    params.Tagging = params.Tagging ? params.Tagging + "&" : "";

                                    params.Tagging = params.Tagging + "execid=" + invocationID;

                                    return recordWrapperCallback((params, cb) => s3.putObject(params, cb),"aws-sdk.s3.putobject")(params, callback);
                                } :
                                p==="getObject" ? recordWrapperCallback((params, cb) => s3.getObject(params, cb),"aws-sdk.S3.getObject") :
                                    target[p]});
                },
                DynamoDB: function (options) {
                    const ddb = new aws.DynamoDB(options);
                    return new Proxy(ddb, {get: (target, p) =>
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

                }
            },
            'nodemailer' : {
                createTransport: (params) => {
                    const mailer = nodemailer.createTransport(params);

                    return {
                        sendMail: recordWrapperPromise(mailer.sendMail, "nodemailer.sendMail"),
                    }
                },
                getTestMessageUrl: recordWrapperPromise(nodemailer.getTestMessageUrl,"nodemailer.getTestMessageUrl"),
            },
            'got' : {
                get: recordWrapperPromise(got.get, "got.get"),
            },
            'node-fetch' : recordWrapperPromise(fetch, "node-fetch.fetch")
        }
    },
};

const vm = new NodeVM(executionEnv);

const vmExports = vm.run(originalLambdaScript, conf.secLambdaFullPath);

let invocationID;

for (let handlerName of conf.handlers) {
    module.exports[handlerName] = function (event, context, callback) {
        flushCounters();

        invocationID = context.invokeid;

        console.log("Recording Execution Context.");

        console.log("#### EVENT ####");
        console.log(JSON.stringify(event));
        console.log("#### EVENTEND ####");

        console.log("#### CONTEXT ####");
        console.log(JSON.stringify(context));
        console.log("#### CONTEXTEND ####");

        vmExports[handlerName](event,context,(err, data) => {

            console.log("Recording Callback.");

            console.log("#### CBACKERR ####");
            console.log(JSON.stringify(err));
            console.log("#### CBACKERREND ####");

            console.log("#### CBACKDATA ####");
            console.log(JSON.stringify(data));
            console.log("#### CBACKDATAEND ####");

            callback(err,data);
        });
    }
}