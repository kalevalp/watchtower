const recorder = require('recorder');
const aws      = require('aws-sdk');
const crypto   = require('crypto');

const s3  = new aws.S3();
const rek = new aws.Rekognition();

const mock = {
    'aws-sdk' : {
        S3: function () {
            return ({
                getObject: (params) => ({
                    promise: () => s3.getObject(params)
                        .promise()
                        .then(data => {
                            const image = data.Body;

                            const hash = crypto.createHash('sha256');
                            hash.update(image.toString());
                            const imageHash = hash.digest('hex');

                            const bucket = params.Bucket;
                            const objectKey = params.Key;
                            console.log(`#####EVENTUPDATE[IMAGE_GET(${bucket},${objectKey},${imageHash})]#####`);
                            return data;
                        }),
                }),
                putObject: (params) => ({
                    promise: () => s3.putObject(params)
                        .promise()
                        .then(data => {
                            const features = params.Body;

                            const hash = crypto.createHash('sha256');
                            hash.update(features.toString());
                            const featuresHash = hash.digest('hex');

                            const bucket = params.Bucket;
                            const objectKey = params.Key;
                            console.log(`#####EVENTUPDATE[FEATURES_PUT(${bucket},${objectKey},${featuresHash})]#####`);
                            return data;
                        }),
                }),
            })},
        Rekognition: function () {
            return ({
                detectLabels: (params) => ({
                    promise: () => rek.detectLabels(params)
                        .promise()
                        .then(data => {
                            const image = params.Image.Bytes;

                            let hash = crypto.createHash('sha256');
                            hash.update(image.toString());
                            const imageHash = hash.digest('hex');

                            hash = crypto.createHash('sha256');
                            const features = JSON.stringify(data.Labels);
                            hash.update(features);
                            const featuresHash = hash.digest('hex');

                            console.log(`#####EVENTUPDATE[DETECT_LABELS(${imageHash},${featuresHash})]#####`);
                            return data;
                        }),
                }),
            })},
    }
};


module.exports.handler = recorder.createRecordingHandler('original-handler.js','handler',mock);