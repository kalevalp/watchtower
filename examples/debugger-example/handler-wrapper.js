const recorder = require('watchtower-recorder');
const rnrBucket = process.env.WATCHTOWER_RNR_S3_BUCKET;

const aws = require('aws-sdk');

const debug = process.env.DEBUG_WATCHTOWER

if (debug) aws.config.logger = console;

let context, lambdaExecutionContext, lambdaInputEvent;
function updateContext(name, event, lambdaContext) { context = name; lambdaExecutionContext = lambdaContext; lambdaInputEvent = event; }

recorder.configureRNRRecording(
    /*enable*/ true,
    /*kinesisStreamName*/ 'notActuallyInUse',
    /*s3BucketName*/ rnrBucket,
    /*getContext*/
    (key) => {
        switch(key) {
        case 'execContext' :
            return lambdaExecutionContext;
        case 'execEvent' :
            return lambdaInputEvent;
        case 'callContext' :
            return context;
        }
    });

const mock = {
    'aws-sdk': recorder.createDDBDocClientMock(),
};

module.exports.consume = recorder.createRecordingHandler('handler.js', 'consume' , mock, true, updateContext, false);
module.exports.produce = recorder.createRecordingHandler('handler.js', 'produce' , mock, true, updateContext, false);
