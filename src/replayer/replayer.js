"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const aws = require("aws-sdk");
const nodemailer = require("nodemailer");
const got = require('got');
const fetch = require('node-fetch');
const {getInvocationTuple, getValueSync} = require("rnr-utils");

const conf = JSON.parse(fs.readFileSync('conf.json', 'utf8'));
const originalLambda = fs.readFileSync(conf.originalLambda, 'utf8');

let handlerName = "handler";

const originalLambdaScript = new VMScript(`

module.exports.runReplayed = (externalEvent, externalContext, externalCallback) => {

    debugger;
    
    ${originalLambda}
    
    module.exports.${handlerName}(externalEvent, externalContext, externalCallback);

}
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
        Math : new Proxy(Math, {get: (target, p) => p==="random" ? () => getValueSync("Math.random") : target[p]}),
    },
    require: {
        context: 'sandbox',
        external: true,
        builtin: ['*'],
        root: "./",
        // mock: {
        //     'aws-sdk': {
        //         config: aws.config,
        //
        //         Kinesis: function () {
        //             const kinesis = new aws.Kinesis();
        //             return {
        //                 putRecord: recordWrapperCallback(kinesis.putRecord),
        //             }
        //         },
        //
        //         StepFunctions: function () {
        //             const stepfunctions = new aws.StepFunctions();
        //             return {
        //                 startExecution: recordWrapperCallback(stepfunctions.startExecution),
        //                 getActivityTask: recordWrapperCallback(stepfunctions.getActivityTask),
        //                 sendTaskFailure: recordWrapperCallback(stepfunctions.sendTaskFailure),
        //                 sendTaskSuccess: recordWrapperCallback(stepfunctions.sendTaskSuccess),
        //             }
        //         },
        //
        //         Rekognition: function () {
        //             const rek = new aws.Rekognition();
        //
        //             return {
        //                 detectLabels: recordWrapperCallback(rek.detectLabels),
        //             }
        //         },
        //     },
        //     'nodemailer' : {
        //         createTransport: (params) => {
        //             const mailer = nodemailer.createTransport(params);
        //
        //             return {
        //                 sendMail: recordWrapperPromise(mailer.sendMail),
        //             }
        //         },
        //         getTestMessageUrl: recordWrapperPromise(nodemailer.getTestMessageUrl),
        //     },
        //     'got' : {
        //         get: recordWrapperPromise(got.get),
        //     },
        //     'node-fetch' : recordWrapperPromise(fetch)
        // }
    },
};

const vm = new NodeVM(executionEnv);

const vmModule = vm.run(originalLambdaScript, conf.secLambdaFullPath);


function replay(groupName, streamName, invocationID) {
    return getInvocationTuple( groupName, streamName, invocationID )
        .then(([event, context]) => {
            vmModule.runReplayed(event, context, () => {
            });
        });
}

module.exports.replay = replay;