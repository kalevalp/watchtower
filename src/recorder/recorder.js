"use strict";

const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");

function createRecordingHandler(originalLambdaFile, originalLambdaHandler, mock, runLocally, updateContext) {

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

    if (updateContext) {
        return (...params) => {
            updateContext(originalLambdaHandler);
            return vmExports[originalLambdaHandler](...params);
        }
    } else {
        return vmExports[originalLambdaHandler];
    }
}

module.exports.createRecordingHandler = createRecordingHandler;
