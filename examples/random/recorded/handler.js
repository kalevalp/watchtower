'use strict';
module.exports.handler = (event, context, callback) => {

    const x = Math.random();
    const y = 100;
    const z = x + y;

    return callback (null, {
        statusCode: 200,
        body: JSON.stringify({
            message: `Got the value ${z}! But why?`,
            input: event,
        }),
    });

    // Use this code if you don't use the http event with the LAMBDA-PROXY integration
    // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};
