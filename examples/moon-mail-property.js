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
    quantifiedVariables: ['message', 'address'], // Universally quantified - determines the instance of the property.
    projections: [['message', 'address'], ['message'], ['address']],

    stateMachine: {

        getNewCompoundState: () => (
            {
                subscribed: new Set(),
                published : new Set(),
            }
        ),

        'SUBSCRIBE': { // SUBSCRIBE(address, list)
            params : [
                'address',
                'list'
            ],
            'ANY' : {
                to: 'SAME',
                update: (curr, address, list) => curr.subscribed.add(list),
            }
        },
        'UNSUBSCRIBE': { // UNSUBSCRIBE(address, list)
            params : [
                'address',
                'list'
            ],
            'ANY' : {
                to: 'SAME',
                update: (curr, address, list) => curr.subscribed.add(list),
            }
        },
        'PUBLISH': { // PUBLISH(message, list)
            params : [
                'message',
                'list'
            ],
            'ANY' : {
                to: 'SAME',
                update: (curr, message, list) => curr.published.add(list),
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
