'use strict';

const aws = require('aws-sdk');

const s3 = new aws.S3();
const bucket = process.env.S3_BUCKET ? process.env.S3_BUCKET : "rnrtempbucket";
let photoKey = "somephotofromthenet.jpg";
let labelsKey = "imageanalysislabels.txt";

aws.config.update({region: 'us-west-2'});

const rek = new aws.Rekognition();

module.exports.handler = (event, context, callback) => {
    s3.getObject(
        {
            Bucket: bucket,
            Key: photoKey
        },

        (err, data) => {
            rek.detectLabels(
                {
                    Image: {
                        Bytes: data.Body,
                    },
                    MaxLabels: 10,
                    MinConfidence: 50,
                },
                (err, data) => {
                    if (err) {
                        console.log(err);
                    }
                    s3.putObject(
                        {
                            Body: JSON.stringify(data.Labels),
                            Bucket: bucket,
                            Key: labelsKey
                        },
                        (err, data) => {
                            if (err) console.log(err);
                            else {
                                return callback (null, {
                                    statusCode: 200,
                                    body: JSON.stringify({
                                        message: `Successfully saved labels in S3. S3 response: ${data}.`,
                                        input: event,
                                    }),
                                });
                            }
                        }
                    )
                });
        });
};


