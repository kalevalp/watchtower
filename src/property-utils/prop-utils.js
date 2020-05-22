const debug = process.env.DEBUG_WATCHTOWER;
const util = require('util');


let reorderGranularity = process.env.WATCHTOWER_REORDER_GRANULARITY;
if (!reorderGranularity) reorderGranularity = 10; // Default to 10ms granularity

function getInstance(prop, eventParams, eventType) {
    let params;
    if (eventType) {
	params = prop.stateMachine[eventType].params;
    } else {
	params = prop.quantifiedVariables;
    }
    let propinstKey = prop.name;
    for (const qvar of params) {
        if (eventParams[qvar]) {
            propinstKey += qvar;
            propinstKey += eventParams[qvar];
        }
    }
    return propinstKey;
}

function setsEqual (a, b) {
    return a.size === b.size && [...a].every(value => b.has(value));
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

// Kind of ignores guarded transitions at the moment.
function getReachabilityMap(property) {
    const states = getReachableStates(propToGraph(property));
    const reachabilityMap = {};

    for (const state of states) {
        const stack = [state];
        const reachable = [];
        while (stack.length !== 0){
            const curr = stack.pop();
            for (const transition of Object.values(property.stateMachine)) {
                if (transition[curr] &&
                    !reachable.includes(transition[curr].to)) {
                    reachable.push(transition[curr].to);
                    stack.push(transition[curr].to);
                }
            }
        }
        reachabilityMap[state] = reachable;
    }

    return reachabilityMap;

}

function convertParams(params) {
    const result = {};
    for (const param in params.M) {
        console.log("converting", param);
        if (params.M[param].S) result[param] = params.M[param].S;
        else if (params.M[param].N) result[param] = Number(params.M[param].N);
        else
            throw "Not implemented yet";
    }
    return result;
}

function eventsTooClose(eventA, eventB) {
    return Math.abs(Number(eventA.timestamp.N) - Number(eventB.timestamp.N)) <= reorderGranularity;
}

function runProperty(property, events, instance, fromStates) {
    let states;
    if (!fromStates) {
        states = [{
            curr: 'INITIAL',
            compound: property.getNewCompoundState ? property.getNewCompoundState() : {},
            replacements: [],
        }];
    } else {
        states = fromStates.map(fromState => ({
	    curr: fromState.curr,
	    compound: JSON.parse(JSON.stringify(fromState.compound)),
            replacements: [],
	}));
    }

    let lastProcessedEvent;

    for (let i = 0; i < events.length; i++) {
        let e = events[i];
        let next = events[i+1];


        // Check if need to interleave histories
        if ( next &&
             eventsTooClose(next, e)) {

            // Find interleaving block
            let block = [];
            let currIdx = i + 1;
            let curr = events[currIdx]; // === next

            while (curr &&
                   eventsTooClose(curr, e)) {

                if ( e.invocation.S !== curr.invocation.S ) block.push[currIdx];
                currIdx++;
                curr = events[currIdx];
            }

            let trueBlock = block.length > 0;

            if (trueBlock) {
                states = states.map(state => {
                    if (Object.keys(state.replacements).length === 0) { // No existing replacements. Simple.
                        return [state].concat(block.map(repIdx => {
                            const newState = {curr: state.curr,
                                              compound: state.compound};
                            newState.replacements = {};
                            newState.replacements[i] = repIdx;
                            newState.replacements[repIdx] = i;

                            return newState;
                        })).flat();
                    } else { // Has existing replacements. A little more complicated.
                        return [state].concat(block.map(repIdx => {
                            const newState = {curr: state.curr,
                                              compound: state.compound};

                            newState.replacements = {};

                            Object.assign(newState.replacements, state.replacements);

                            if (newState.replacements[repIdx]) {
                                newState.replacements[i] = newState.replacements[repIdx];
                            } else {
                                newState.replacements[i] = repIdx;
                            }

                            newState.replacements[repIdx] = i;

                            return newState;
                        }));
                    }
                });
            }
        }

        if (debug) console.log("Running the property.\nStates are: ", util.inspect(states));

        states = states.map(state => {
            let stateSpecificEvent;
            if (state.replacements[i]) {
                stateSpecificEvent = events[state.replacements[i]];
                delete state.replacements[i];
            } else {
                stateSpecificEvent = e;
            }

            const eventType = stateSpecificEvent.type.S;
            const eventParamsDict = convertParams(stateSpecificEvent.params);

            // const eventInvocationUuid = e.invocation.S;



            // KALEV: This feature is only partially supported, and entirely not documented.
            // TODO: Add check to sanity to ensure that if there's ANY, there's nothing else.
            const transition =
                  property.stateMachine[eventType]['ANY'] ?
                  property.stateMachine[eventType]['ANY'] :
                  property.stateMachine[eventType][state.curr];

            if (transition) {
                // Sanity check that the quantified variable assignment matches the current property instance
                for (let i = 0; i < property.stateMachine[eventType].params.length; i++) {
                    const varname = property.stateMachine[eventType].params[i];

                    if (property.quantifiedVariables.includes(varname)) { // This variable is used to determine the property instance

                        if (eventParamsDict[varname] !== instance[varname]) {
                            throw "ERROR: Encountered an event whose parameters don't match the instance.";
                        }
                    }
                }

                let update;
                let toState;

                if (transition['GUARDED_TRANSITION']) {
                    const guardValuation = transition['GUARDED_TRANSITION'].guard(...Object.values(eventParamsDict));

                    if (guardValuation) {
                        update = transition['GUARDED_TRANSITION'].onGuardHolds.update;
                        toState = transition['GUARDED_TRANSITION'].onGuardHolds.to;

                    } else {
                        update = transition['GUARDED_TRANSITION'].onGuardViolated.update;
                        toState = transition['GUARDED_TRANSITION'].onGuardViolated.to;
                    }
                } else {
                    update = transition.update;
                    toState = transition.to;
                }
                if (update)
                    update(state.compound, ...Object.values(eventParamsDict));

                state.curr = toState;

                lastProcessedEvent = e;

                // if (toState in ['FAILURE', 'SUCCESS']) // TODO - Optimize a run reaching a terminal
                //     break;
            }
            return state;
        });

        // Remove coalescing states with no replacements
        states = states.reduce((acc,elem) => {
            if (Object.keys(elem.replacements).length !== 0 || // Keep if has replacements
                !acc.some(other =>
                          other.curr === elem.curr && // States coalesce
                          Object.keys(other.replacements).length === 0)) { // And other state also has no replacements
                acc.push(elem);
            }
            return acc;
        }, []);
        // // remove coalescing states with equal replacements
        // //   Ignoring compound. (Let's call this step 2 of depracation. Can also say I don't remember what the point of that is anymore.)
        // states = states.reduce((acc, elem) => {
        //     if (!acc.some(other =>
        //                   other.curr === elem.curr &&
        //                   Object.keys(other.replacements).length === Object.keys(elem.replacements).length &&
        //                   Object.keys(other.replacements).reduce((acc, curr, idx) =>
        //                                                          acc &&
        //                                                          elem.replacements[idx] === curr,
        //                                                          true))) {
        //         acc.push(curr);
        //     }
        //     return acc;
        // }, []);
    }
    return {
        states,
        lastProcessedEvent,
    };
}

// stablePrefix is the part of the execution that is guaranteed to be consistent
// partialTail is the part of the execution that might be missing some events
// stablePrefix::partialTail lead to a violation
// expected type of execution: events, as returned for DDB
// Return: false if violation cannot be avoided via an extension of partialTail
//         true if it can be
//         TODO - consider returning the potential event sequence.
function hasNonViolatingExtension(property, stablePrefix, partialTail, instance) {
    if (partialTail.length === 0) return false;

    const reachabilityMap = getReachabilityMap(property);
    let {state} = runProperty(property,stablePrefix, instance);

    function extensionSearch(fromState, tailSuffix, targetState) {
        if (tailSuffix.length > 0) {
            const event = tailSuffix[0];
            const reachable = reachabilityMap[fromState];
            const reachableAfterStep = [];
            for (state of reachable) {
                if (property.stateMachine[event.type.S] && property.stateMachine[event.type.S][state]) {
                    const toState = property.stateMachine[event.type.S][state].to; // TODO - make sure type is correct
                    if (!reachableAfterStep.includes(toState))
                        reachableAfterStep.push(toState);
                }
            }
            if (tailSuffix.length === 1) { // Final transition
                if (!reachableAfterStep.every(state => state === 'FAILURE')) {
                    return true;
                }
            }
            for (state of reachableAfterStep) {
                const mayReachAnotherState = extensionSearch(state, tailSuffix.slice(1), targetState);
                if (mayReachAnotherState)
                    return true;
            }
        }
        return false;
    }

    return extensionSearch(state.curr, partialTail)
}

module.exports.getTerminatingTransitions = getTerminatingTransitions;
module.exports.hasNonViolatingExtension = hasNonViolatingExtension;
module.exports.runProperty = runProperty;
module.exports.getInstance = getInstance;
