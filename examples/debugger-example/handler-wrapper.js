const recorder = require('watchtower-recorder');
const rnrBucket = process.env.WATCHTOWER_RNR_S3_BUCKET;

const aws = require('aws-sdk');

const debug = process.env.DEBUG_WATCHTOWER

if (debug) aws.config.logger = console;

let context, lambdaExecutionContext, lambdaInputEvent;
function updateContext(name, event, lambdaContext) { context = name; lambdaExecutionContext = lambdaContext; lambdaInputEvent = event; }

recorder.configureRNRRecording(/*enable*/ true, /*kinesisStreamName*/ 'notActuallyInUse', /*s3BucketName*/ rnrBucket, /*getContext*/ () => lambdaExecutionContext )

const mock = {
    'aws-sdk': aws
};

module.exports.consume = recorder.createRecordingHandler('handler.js', 'consume' , mock, true, updateContext, true);
module.exports.produce = recorder.createRecordingHandler('handler.js', 'produce' , mock, true, updateContext, true);
