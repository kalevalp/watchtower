/* ****************************************************************************
 *
 * Safety property:
 *   The same email is not sent to the same address twice.
 *
 *   \forall{a: address, e: email} : sent(a, e) => X G ( ! sent(a, e) )
 *
 *   State Machine:
 *   Quantified (instantiated?) over a: address, e: email
 *
 *   ->() ---a,e---> () ---a,e---> (())
 *
 *************************************************************************** */

/* ****************************************************************************
 *
 * This variant of the property is *not* instantiated. It reads all relevant
 * events from the database, and looks for a violation.
 *
 *************************************************************************** */


const aws = require('aws-sdk');
const ddb = new aws.DynamoDB();
// const property = {};
// const matchSendRE = /^SEND([A-Za-z0-9.\-_]*@[A-Za-z0-9.\-_]*)##(.*)SEND$/;
// const propertyTable = process.env.PROPERTY_TABLE;

const events = ['SEND'];
// const instance = {
//     a: '',
//     b: '',
// }

function getEvents (collectedEvents, params) {
    return ddb.query(params).promise()
        .then(data => {
            if (data.LastEvaluatedKey) {
                params.ExclusiveStartKey = data.LastEvaluatedKey;
                return getEvents(collectedEvents.concat(data.Items), params)
            } else {
                return collectedEvents.concat(data.Items)
            }
        })
}


module.exports.handler = async function(event, context) {

    const events = [];

    for (const event of events) {
        const queryRequest = {
            TableName: process.env.EVENTS_TABLE,
            KeyConditionExpression: `type = :${event}`,
        };

        events.push(getEvents([], queryRequest));
    }

    Promise.all(events)
        .then(results => [].concat(...results)) // Return a single array consisting of all events.
        .then(results => results.sort((a, b) => a.timestamp - b.timestamp)) // Sort by timestamp

};




// property.event = (update) => {
//     const sendEvent = update.match(matchSendRE);
//     if (sendEvent) {
//         const address = sendEvent[1];
//         const email = sendEvent[2];
//
//         const params = {
//             Item: {
//                 address: address,
//                 email: email,
//             },
//             TableName: propertyTable,
//             ReturnValues: 'ALL_OLD',
//         };
//
//         // TODO: callback/promisify
//         ddb.putItem(params, (err, data) => {
//             if (err) {
//
//             }// Do something
//             else {
//                 if (Object.keys(data.Attributes) !== 0) {
//                     // Violation!
//                 }
//             }
//         });
//     }
// };
//
// monitor.setProperty(property);
//
// module.exports.handler = monitor.handler;