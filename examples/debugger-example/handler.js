'use strict';

const aws = require('aws-sdk');
const lorem = require('lorem-ipsum');

function wrap(data) {
    return {
        statusCode: 200,
        body: JSON.stringify(
            {
                response: data,
            },
            null,
            2
        ),
    };
}

async function produce(event, context) {

}

async function consume(event, context) {

}



module.exports.produce = produce;
module.exports.consume = consume;
