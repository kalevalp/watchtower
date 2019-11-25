if (process.argv[2] === '--test') {
    const property = {
        name: 'dummy',
        quantifiedVariables: ['eventid'],
        projections: [['eventid']],
        stateMachine: {
            'DUMMY_EVENT_TYPE_A': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'intermediate',
                },
                'intermediate': {
                    to: 'SUCCESS',
                },
            },
            'DUMMY_EVENT_TYPE_B': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'SUCCESS',
                },
                'intermediate': {
                    to: 'FAILURE',
                },
            },
        },
    };

    console.log(getReachabilityMap(property));
} else if (false) {
    const events = [
        {
            "eventid": {
                "S": "58d28801-4e21-449b-879b-daa826fc94c8"
            },
            "invocation": {
                "S": "60049d4f-2218-4ae7-9217-89fecb2fe992"
            },
            "params": {
                "M": {
                    "eventid": {
                        "S": "58d28801-4e21-449b-879b-daa826fc94c8"
                    }
                }
            },
            "timestamp": {
                "N": "1571684157549"
            },
            "id": {
                "S": "wt-full-flow-test-hello_49600642134451176209918005304233992157266241008540057618"
            },
            "propinst": {
                "S": "dummyeventid58d28801-4e21-449b-879b-daa826fc94c8"
            },
            "type": {
                "S": "DUMMY_EVENT_TYPE_A"
            }
        }
    ];

    const property = {
        name: 'dummy',
        quantifiedVariables: ['eventid'],
        projections: [['eventid']],
        stateMachine: {
            'DUMMY_EVENT_TYPE_A': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'intermediate',
                },
                'intermediate': {
                    to: 'SUCCESS',
                },
            },
            'DUMMY_EVENT_TYPE_B': {
                params: ['eventid'],
                'INITIAL': {
                    to: 'SUCCESS',
                },
                'intermediate': {
                    to: 'FAILURE',
                },
            },
        },
    };

    let state;
    let lastProcessedEvent;

    const stableIntermediateState = runProperty(property, []);
    state = stableIntermediateState.state;
    lastProcessedEvent = stableIntermediateState.lastProcessedEvent;
    const partialExecutionState = runProperty(property, events, state);
} else if (false) {
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
                            to: 'INITIAL',
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


    // stateMachineSanityChecks(property);

    console.log(getTerminatingTransitions(property));
}
