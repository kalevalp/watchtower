const monitor = require('./monitor');
const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
const property = {};
const matchSendRE = /^SEND([A-Za-z0-9.\-_]*@[A-Za-z0-9.\-_]*)##(.*)SEND$/;
const propertyTable = process.env.PROPERTY_TABLE;


property.event = (update) => {
    const sendEvent = update.match(matchSendRE);
    if (sendEvent) {
        const address = sendEvent[1];
        const email = sendEvent[2];

        const params = {
            Item: {
                address: address,
                email: email,
            },
            TableName: propertyTable,
            ReturnValues: 'ALL_OLD',
        };

        // TODO: callback/promisify
        ddb.putItem(params, (err, data) => {
            if (err) {

            }// Do something
            else {
                if (Object.keys(data.Attributes) !== 0) {
                    // Violation!
                }
            }
        });
    }
};

monitor.setProperty(property);

module.exports.handler = monitor.handler;