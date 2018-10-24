const {monitorFactory} = require('./monitor');

const events = ['SEND', 'CREATEEMAIL', 'SUBSCRIBE', 'UNSUBSCRIBE'];

const subscriptions = {};

function processEvent(e) {
    if (e.type.match(/SEND/)) {
        const user = e.params[0];
        const mailingList = e.params[2];

    } else if (e.type.match(/CREATEEMAIL/)) {

    } else if (e.type.match(/SUBSCRIBE/)) {
        const user = e.params[0];
        const mailingList = e.params[1];

        if (!subscriptions[user]) {
            subscriptions[user] = new Set();
        }

        subscriptions[user].add(mailingList);
    } else if (e.type.match(/UNSUBSCRIBE/)) {
        const user = e.params[0];
        const mailingList = e.params[1];

        if (subscriptions[user]) {
            // subscriptions[user] = new Set();
            subscriptions[user].delete(mailingList);
        }

    }
}