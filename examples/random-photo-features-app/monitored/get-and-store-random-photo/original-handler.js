'use strict';

const aws          = require('aws-sdk');
const fetch        = require('node-fetch');
const randomstring = require('randomstring');

const s3 = new aws.S3();

const bucket = process.env.S3_BUCKET ? process.env.S3_BUCKET : "rnrtempbucket";

module.exports.handler = async () => {

    const randomID = randomstring.generate();
    const photoKey = `photo_${randomID}.jpg`;

    return await fetch("https://source.unsplash.com/random")
        .then((response) => {
            if (response.ok) {
                return response;
            } else {
                return Promise.reject(new Error(
                    `Failed to fetch ${response.url}: ${response.status} ${response.statusText}`));
            }
        })
        .then(response => response.buffer())
        .then(buffer => s3.putObject({ Body: buffer, Bucket: bucket, Key: photoKey }).promise())
        .then(() => ({randomID}))
        .catch(err => Promise.reject(new Error(err)));
};