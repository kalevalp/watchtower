'use strict';

const aws = require('aws-sdk');

const s3  = new aws.S3();
const rek = new aws.Rekognition();

const bucket = process.env.S3_BUCKET ? process.env.S3_BUCKET : "rnrtempbucket";

module.exports.handler = async (event) => {

    console.log(event);

    const randomID  = event.randomID;
    const photoKey  = `photo_${randomID}.jpg`;
    const labelsKey = `photo_${randomID}_labels.txt`;

    console.log(photoKey);
    console.log(labelsKey);

    return s3.getObject({ Bucket: bucket, Key: photoKey }).promise()
        .then(data => rek.detectLabels({ Image: { Bytes: data.Body }, MaxLabels: 10, MinConfidence: 50 }).promise())
        .then(data => s3.putObject({ Body: JSON.stringify(data.Labels), Bucket: bucket, Key: labelsKey }).promise())
        .catch(err => Promise.reject(new Error(err)));
};


