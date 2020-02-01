const {NodeVM,VMScript} = require("vm2");
const fs = require("fs");
const util = require('util');

const aws = require('aws-sdk');
// const serialize = require('serialize-javascript-w-cycles');
const zlib = require('zlib');
const gunzip = util.promisify(zlib.gunzip);

const kinesis = new aws.Kinesis();
const s3 = new aws.S3();

const debug = process.env.DEBUG_WATCHTOWER;

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
            debugger;
            return vmExports[originalLambdaHandler](event, context);
        }
    } else {
	return (event, context, callback) => {
            debugger;
	    return vmExports[originalLambdaHandler](event, context, callback);
	}
    }
}

async function replayAsyncHandler(executionID, handler, s3BucketName) {
    const history = await s3.listObjects({Bucket: s3BucketName, Prefix: executionID}).promise();

    // TODO - handle history larger than 1000 objects

    // const hist = await Promise.all((await Promise.all(history.Contents
    //                                                   .map(item => item.Key)
    //                                                   .map(async Key => (
    //                                                       {
    //                                                           key: Key,
    //                                                           item: await s3.getObject({Key, Bucket: s3BucketName}).promise()
    //                                                       }))))
    //                                .map(async ({key, item}) => (
    //                                    {
    //                                        key,
    //                                        item: (await gunzip(item.Body)).toString()
    //                                    })))


    const hist = await Promise.all(history.Contents
                                   .map(item => item.Key)
                                   .map(async Key => (
                                       {
                                           key: Key,
                                           item: ((await s3.getObject({Key, Bucket: s3BucketName}).promise()).Body.toString())
                                       })))

    debugger;

    console.log(hist);

    // TODO
}

function replayCBackHandler(executionID, handler, s3BucketName) {
    // TODO
}

module.exports.replayAsyncHandler = replayAsyncHandler;

if (require.main === module) {
    const execId = process.argv[2];

    replayAsyncHandler(execId,'','wtrnrbucket');
}
