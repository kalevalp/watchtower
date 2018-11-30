// Property:
//   If an image is sent to the Rekognition, then that image had previously
//   been fetched from https://source.unsplash.com/random

const property = {
    name: 'simpleprop',
    quantifiedVariables: ['image'],
    projections: [['image']], // This property has a single projection, on the single quantified variable in the property.
                              // Union over all projections should equal to quantifiedVariables.
                              // Also, all projections should be ordered (matching quantifier order).

    // Determinism is enforced by well-formedness of the JSON object.
    stateMachine: {
        'IMAGE_FETCH' : {
            filter: (url, image) => url === 'https://source.unsplash.com/random', // Only record image fetches from unsplash
            params: [
                'url', // Record fetches from unsplash random
                'image', // Quantified over the fetched image
            ],
            'INITIAL' : {
                'GUARDED_TRANSITION': {
                    guard: (url, image) => url === 'https://source.unsplash.com/random',
                    guardParams: ['url'],
                    onGuardHolds: {
                        to: 'fetched',
                    },
                    onGuardViolated: {
                        to: 'SAME',
                    },
                },
            },
        },
        'DETECT_LABELS' : {
            params: [
                'image', // Same variable the property is quantified over
                'IGNORE', // Second parameter of the DETECT_LABELS event is not relevant to this property
            ],
            'INITIAL' : { // Predefined initial state.
                to: 'FAILURE', // Predefined terminal violating state.
            },
            'fetched' : {
                to: 'SUCCESS', // Predefined terminal non-violating state.
            },
        },
    }
};

module.exports = property;
