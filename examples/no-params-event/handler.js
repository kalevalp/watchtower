'use strict';
const dummy = require('dummy');

module.exports.hello = async (event, context) => {
    dummy.operation();
    return {
        statusCode: 200,
        body: JSON.stringify({
            message: 'Go Serverless v1.0! Your function executed successfully!',
            input: event,
        }),
    };
};
