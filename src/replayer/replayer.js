const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");

function createReplayHandler(originalLambdaFile, originalLambdaHandler, mock, updateContext, useCallbacks = false) {

    const originalLambdaPath    = originalLambdaFile;
    const originalLambdaCode    = fs.readFileSync(originalLambdaFile, 'utf8');
    const originalLambdaScript  = new VMScript(`debugger;\n${originalLambdaCode}`);

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
            return vmExports[originalLambdaHandler](event, context);
        }
    } else {
	return (event, context, callback) => {
	    return vmExports[originalLambdaHandler](event, context, callback);
	}
    }
}

async function replayAsyncHandler(executionID, handler) {
    // TODO
}

function replaycbackHandler(executionID, handler) {
    // TODO
}


