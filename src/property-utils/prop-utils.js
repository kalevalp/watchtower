const graphviz = require('graphviz');


function setsEqual (a, b) {
    return a.size === b.size && [...a].every(value => b.has(value));
}

function printStateMachine(property) {
    const graph = propToGraph(property);

    const g = graphviz.digraph("G");

    for (const fromState in graph) {
        for (const transition of graph[fromState]) {
            g.addEdge(fromState, transition.to, {label: transition.transition});
        }
    }

    g.output( "png", "property.png" );
}

function propToGraph(prop) {

    const graph = {};

    for (const event in prop.stateMachine) { if (prop.stateMachine.hasOwnProperty(event)) {
        const eventTransitions = prop.stateMachine[event];
        for (const fromState in eventTransitions) { if (eventTransitions.hasOwnProperty(fromState)) {
            if ( fromState !== 'filter' && fromState !== 'params') {
                if (!graph[fromState])
                    graph[fromState]= [];

                if (eventTransitions[fromState]['GUARDED_TRANSITION']) {
                    const trueTransition = {
                        to : eventTransitions[fromState]['GUARDED_TRANSITION'].onGuardHolds.to,
                        transition : event,
                        guardedTransition : true,
                        guard : eventTransitions[fromState]['GUARDED_TRANSITION'].guard,
                        update : eventTransitions[fromState]['GUARDED_TRANSITION'].onGuardHolds.update,
                    };
                    const falseTransition = {
                        to : eventTransitions[fromState]['GUARDED_TRANSITION'].onGuardViolated.to,
                        transition : event,
                        guardedTransition : true,
                        guard : `Negation of ${eventTransitions[fromState]['GUARDED_TRANSITION'].guard}`,
                        update : eventTransitions[fromState]['GUARDED_TRANSITION'].onGuardViolated.update,
                    };

                    graph[fromState].push(trueTransition);
                    graph[fromState].push(falseTransition);
                } else {
                    const trans = {
                        to : eventTransitions[fromState].to,
                        transition : event,
                        guardedTransition : false,
                        update : eventTransitions[fromState].update,
                    };

                    graph[fromState].push(trans);
                }
            }
        }}
    }}
    return graph;
}

function getAllStates(graph) {
    const allStates = new Set();

    for (const fromNode in graph) {
        allStates.add(fromNode);
        for (const transition of graph[fromNode]) {
            allStates.add(transition.to);
        }
    }
    return allStates;
}

function getTerminatingStates(graph) {
    const allStates = getAllStates(graph);

    return getTerminatingStatesInternal(allStates, graph);
}

function getTerminatingStatesInternal(allStates, graph) {

    const terminating = new Set();

    for (const state of allStates) {
        if (!graph[state])
            terminating.add(state);
    }
    return terminating;
}

function getReachableStates(graph) {
    const stateStack = ['INITIAL'];
    const reachable = new Set();

    while (stateStack.length > 0) {
        const curr = stateStack.pop();

        if (!reachable.has(curr)) {
            reachable.add(curr);

            if (graph[curr]) { // Not a terminal state
                for (const transition of graph[curr]) {
                    stateStack.push(transition.to);
                }
            }
        }
    }
    return reachable;
}

function stateMachineSanityChecks(property) {

    const graph = propToGraph(property);

    const allStates = getAllStates(graph);
    const terminating = getTerminatingStatesInternal(allStates, graph);

    for (const state of terminating) {
        if (state !== 'SUCCESS' && state !== 'FAILURE') {
            throw `ERROR: MALFORMED STATE MACHINE: The state ${state} is a terminating state (i.e., it has no outgoing edges) --- only SUCCESS and FAILURE states can be terminating states.`
        }
    }

    if (terminating.size === 0) {
        throw `ERROR: MALFORMED STATE MACHINE: No terminating states found in state machine. Must have either a SUCCESS or FAILURE state.`
    }

    const reachable = getReachableStates(graph);

    if (setsEqual(reachable, allStates))
        console.log('WARNING: UNREACHABLE STATES IN STATE MACHINE');
}

function getTerminatingTransitions(property) {
    const graph = propToGraph(property);
    const terminating = getTerminatingStates(graph)

    const terminatingTransitions = new Set();

    for (const fromState in graph) {
        for (const trans of graph[fromState]) {
            if (terminating.has(trans.to)) {
                terminatingTransitions.add(trans.transition);
            }
        }
    }

    return terminatingTransitions;
}

module.exports.getTerminatingTransitions = getTerminatingTransitions;


if (process.argv[2] === '--test') {
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


