// Property:
//   If an image is sent to the Rekognition, then that image had previously
//   been fetched from https://source.unsplash.com/random

// Limitations of the property definition:
//   * Don't support having the same event in different configurations in one property (e.g., once with the first param
//     const and the second quantified, and another time with the second const and the first quantified.)
//     This is a technical limitation, which can be solved by conservatively over-approximating what needs to be
//     recorded, at the cost of unnecessary recording.
//     Another alternative is to have a list for every event type, one per distinct instance of the event type in the
//     property.

const property = {
    name: 'simpleprop',
    predicates: ['IMAGE_FETCH', 'DETECT_LABELS'],
    quantifiedVariables: ['image'],
    projections: [['image']], // This property has a single projection, on the single quantified variable in the property.
                              // Union over all projections should equal to quantifiedVariables.
                              // Also, all projections should be ordered (matching quantifier order).
    events: {
        'IMAGE_FETCH': {
            quantifierMap: {
                'image': 1, // The second param of the property is the 'image' quantified variable of the property.
            },
            consts: {
                0: ['https://source.unsplash.com/random'],  // The first param of the property is a const to be matched
            }
        },
        'DETECT_LABELS': {
            quantifierMap: {
                'image': 0,
            }
        }
    },
    // Determinism is enforced by well-formedness of the JSON object.
    stateMachine: {
        'IMAGE_FETCH' : {
            'INITIAL' : {
                to: 'fetched',
                params: [
                    'const__https://source.unsplash.com/random', // Record fetches from unsplash random
                    'var__image', // Quantified over the fetched image
                ]
            },
        },
        'DETECT_LABELS' : {
            'INITIAL' : { // Predefined initial state.
                to: 'FAILURE', // Predefined terminal violating state.
                params: [
                    'var__image',
                ],
            },
            'fetched' : {
                to: 'SUCCESS', // Predefined terminal non-violating state.
                params: [
                    'var__image', // Same variable the property is quantified over
                ],
            },
        },
    }
};

module.exports = property;
