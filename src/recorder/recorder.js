"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");

const originalLambdaFile    = process.env['ORIGINAL_LAMBDA_FILE'];
const originalLambdaHandler = process.env['ORIGINAL_LAMBDA_HANDLER'];
const originalLambdaPath    = `/var/task/${originalLambdaFile}`;
// const originalLambdaPath    = `${__dirname}/${originalLambdaFile}`;

const originalLambdaCode    = fs.readFileSync(originalLambdaFile, 'utf8');

const originalLambdaScript  = new VMScript(originalLambdaCode);

function createRecordingHandler(module, mock) {

    let executionEnv = {
        console: 'inherit',
        sandbox: {
            process: process,
        },
        require: {
            context: 'sandbox',
            external: true,
            builtin: ['*'],
            root: "./",
            mock: mock,
        },
    };

    const vm = new NodeVM(executionEnv);

    const vmExports = vm.run(originalLambdaScript, originalLambdaPath);

    module.exports[originalLambdaHandler] = vmExports[originalLambdaHandler];
}