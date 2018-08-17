'use strict';

module.exports.hello = (event, context, callback) => {

    const x = 2;
    const y = 3;

    const z = x + x;

    return callback (null, {
        statusCode: 200,
        body: JSON.stringify({
            message: `Hello, world! The result of the computation is: ${z}. Expecting 5. Is it the same?\nNo? Lets debug!`,
            input: event,
        }),
    });

    // Use this code if you don't use the http event with the LAMBDA-PROXY integration
    // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};
