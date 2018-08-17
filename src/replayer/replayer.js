"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require("aws-sdk");
const nodemailer = require("nodemailer");
const got = require('got');
const fetch = require('node-fetch');

const conf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const unsecuredLambda = fs.readFileSync(conf.unsecLambda, 'utf8');

let handlerName = "";

const originalLambdaScript = new VMScript(`
debugger;

${unsecuredLambda}

module.exports.${handlerName}(externalEvent, externalContext, externalCallback);
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
