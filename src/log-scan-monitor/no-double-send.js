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

const {monitorFactory} = require('./monitor');

function instantiateProperty(address, email) {
    let currentState;

    return () => {
        if (currentState) throw "PROPERTY VIOLATION";
        else currentState = 1;
    }
}

module.exports.handler = monitorFactory(instantiateProperty);