'use strict';

const aws = require('aws-sdk');
const fetch = require('node-fetch');
// const fs = require('fs');

const s3 = new aws.S3();
const bucket = process.env.S3_BUCKET ? process.env.S3_BUCKET : "rnrtempbucket";
let photoKey = "somephotofromthenet.jpg";

module.exports.handler = (event, context, callback) => {

    fetch("https://source.unsplash.com/random")
        .then((response) => {
            debugger;
            if (response.ok) {
                return response;
            }
            return Promise.reject(new Error(
                `Failed to fetch ${response.url}: ${response.status} ${response.statusText}`));
        })
        .then(response => response.buffer())
        .then(buffer => {
            // s3.createBucket({Bucket: bucket},
            //     (err) => {
            //         if (err) console.log(err);
            //         else {
            //             console.log("Successfully 'created bucket'.")
                        debugger;
                        s3.putObject(
                            {
                                Body: buffer,
                                Bucket: bucket,
                                Key: photoKey
                            },
                            (err, data) => {
                                debugger;
                                if (err) console.log(err);
                                return callback (null, {
                                    statusCode: 200,
                                    body: JSON.stringify({
                                        message: `Successfully saved random image in S3. S3 response: ${data}.`,
                                        input: event,
                                    }),
                                });
                            }
                        )
                    // }
                // }
            // )
        });
// .then(buffer => {
//     const fd = fs.openSync('/Users/alpernask/Desktop/img.jpg','w');
//     fs.write(fd,buffer, () => console.log('Finished writing random image!'));
// });
};