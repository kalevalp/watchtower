const recorder = require('recorder');
const aws      = require('aws-sdk');
const fetch    = require('node-fetch');
const crypto   = require('crypto');

const s3  = new aws.S3();

const mock = {
    'aws-sdk' : {
        S3: function () {
            return ({
                putObject: (params) => ({
                    promise: () => s3.putObject(params)
                        .promise()
                        .then(data => {
                            const image = params.Body;

                            const hash = crypto.createHash('sha256');
                            hash.update(image.toString());
                            const imageHash = hash.digest('hex');

                            const bucket = params.Bucket;
                            const objectKey = params.Key;
                            console.log(`#####EVENTUPDATE[IMAGE_PUT(${bucket},${objectKey},${imageHash})]#####`);
                            return data;
                        }),
                }),
            })},
    },
    'node-fetch' : (params) => fetch(params)
        .then(response => {
            if (response.ok) {
                return response.buffer()
                    .then(buffer => {
                        const hash = crypto.createHash('sha256');
                        hash.update(buffer.toString());
                        const imageHash = hash.digest('hex');

                        console.log(`#####EVENTUPDATE[IMAGE_FETCH(${params},${imageHash})]#####`);

                        return {
                            ok: response.ok,
                            buffer: () => Promise.resolve(buffer),
                        };
                    })
            } else {
                return response;
            }
        }),
};


module.exports.handler = recorder.createRecordingHandler('original-handler.js','handler',mock);

