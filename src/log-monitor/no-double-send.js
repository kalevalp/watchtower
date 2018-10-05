const monitor = require('./monitor');
const aws = require('aws-sdk');

const property = {};
const matchSendRE = /^SEND([A-Za-z0-9.\-_]*@[A-Za-z0-9.\-_]*)##(.*)SEND$/;

property.event = (update) => {
    const sendEvent = update.match(matchSendRE);
    if (sendEvent) {
        const address = sendEvent[1];
        const email = sendEvent[2];
    }
};

monitor.setProperty(property);

module.exports.handler = monitor.handler;