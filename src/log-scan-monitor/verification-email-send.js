const {monitorFactory} = require('./monitor');

const events = ['SEND', 'SIGNUP'];

const signups = {};

function processEvent(e) {
    if (e.type.match(/SEND/)) {
        const address = e.params[0];

        if (!signups[address]) throw "PROPERTY VIOLATION";
    } else if (e.type.match(/SIGNUP/)) {
        const address = e.params[0];

        if (signups[address]) throw "PROPERTY VIOLATION";
        else signups[address] = 1;
    }
}