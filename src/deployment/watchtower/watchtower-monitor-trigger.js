const stateMachineArn = process.env['WATCHTOWER_CHECKER_SM_ARN'];

const aws = require('aws-sdk');
const sf = new aws.StepFunctions();

const uuidv4 = require('uuid/v4');

async function triggerCheckerStateMachine(event) {
    const execid = uuidv4();

    // Options: 'runTwice', 'runOnce'
    event.checkerFlow = "runTwice";

    event.stabilityDelay = 7; // In seconds

    event.triggerStartTime = Date.now();

    const execParams = {
	stateMachineArn,
	input: JSON.stringify(event),
	name: execid,
    }

    return sf.startExecution(execParams).promise();
};

module.exports.handler = triggerCheckerStateMachine;
