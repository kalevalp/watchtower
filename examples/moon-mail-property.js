/* *****************************************************************
 * Property:
 *   An email can be sent only to an address that had been subscribed to a mailing list,
 *   had not been unsubscribed since then, and the email was published to the mailing list.
 */

function intersection(setA, setB) {
    var _intersection = new Set();
    for (var elem of setB) {
        if (setA.has(elem)) {
            _intersection.add(elem);
        }
    }
    return _intersection;
}

const property = {
    name: 'emailtosubscribed',
    // predicates: ['SUBSCRIBE', 'UNSUBSCRIBE', 'PUBLISH', 'SEND'],
    quantifiedVariables: ['message', 'address'], // Universally quantified - determines the instance of the property.
    // stateVariables: ['list'], // Complex property state machines may have a state variables. In this case the property maintains two sets of mailing lists.
    projections: [['message', 'address'], ['message'], ['address']],
    // events: {
    //     'SUBSCRIBE': { // SUBSCRIBE(address, list)
    //         quantifierMap: {
    //             'address': 0, // The first parameter of SUBSCRIBE is the 'address' quantified variable.
    //         },
    //         stateVarMap: {
    //             'list': 1, // The second parameter of SUBSCRIBE is the 'list' FSM state variable.
    //         },
    //     },
    //     'UNSUBSCRIBE': { // UNSUBSCRIBE(address, list)
    //         quantifierMap: {
    //             'address': 0,
    //         },
    //         stateVarMap: {
    //             'list': 1,
    //         },
    //     },
    //     'PUBLISH': { // PUBLISH(message, list)
    //         quantifierMap: {
    //             'message': 0,
    //         },
    //         stateVarMap: {
    //             'list': 1,
    //         },
    //     },
    //     'SEND': { // SEND(message, address)
    //         quantifierMap: {
    //             'message': 0,
    //             'address': 1,
    //         },
    //         stateVarMap: {},
    //     },
    // },
    // Determinism is enforced by well-formedness of the JSON object.
    stateMachine: {

        subscribed: new Set(),
        published : new Set(),

        'SUBSCRIBE': { // SUBSCRIBE(address, list)
            params : [
                'address',
                'list'
            ],
            'ANY' : {
                to: 'SAME',
                update: (address, list) => subscribed.add(list),
            }
        },
        'UNSUBSCRIBE': { // UNSUBSCRIBE(address, list)
            params : [
                'address',
                'list'
            ],
            'ANY' : {
                to: 'SAME',
                update: (address, list) => subscribed.add(list),
            }
        },
        'PUBLISH': { // PUBLISH(message, list)
            params : [
                'message',
                'list'
            ],
            'ANY' : {
                to: 'SAME',
                update: (message, list) => published.add(list),
            }

        },
        'SEND': { // SEND(message, address)
            params : [
                'message',
                'address',
            ],
            'INITIAL' : {
                'GUARDED_TRANSITION': {
                    guard: (message, address) => intersection(subscribed, published).size !== 0,
                    onGuardHolds: {
                        to: 'SUCCESS',
                    },
                    onGuardViolated: {
                        to: 'FAILURE',
                    },
                },
            }
        },
    }
};

module.exports = property;
