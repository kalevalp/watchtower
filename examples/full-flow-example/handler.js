'use strict';
const dummy = require('dummy');
const uuidv4 = require('uuid/v4');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports.hello = async (event, context) => {
    const input = JSON.parse(event.body);
    const eventType = input.type;
    let message;

    const opid = uuidv4();

    if (eventType==='A') {
        message = `Scenario: Operation A.`;
        dummy.operationA(opid);
    } else if (eventType==='B') {
        message = 'Scenario: Operation B.';
        dummy.operationB(opid);
    } else if (eventType==='C') {
        message = 'Scenario: Operation A and then Operation B.';
        dummy.operationA(opid);
        await sleep(5000);
        dummy.operationB(opid);
    } else {
        message = "Unexpected operation command";
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            message,
            opid
        }),
    };
};
