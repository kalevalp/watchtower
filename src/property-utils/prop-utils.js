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

module.exports.getTerminatingTransitions = getTerminatingTransitions;
module.exports.runProperty = runProperty;
module.exports.getInstance = getInstance;

// if (require.main === module) {
//     const createProp = (id) => {
//         const prop = {
//             name: `dummy-${id}`,
//             quantifiedVariables: ['someid'],
//             projections: [['someid']],
//             stateMachine: {}
//         }

//         prop.stateMachine[`EVENT_TYPE_A_${id}`] = {
// 	    params: ['someid'],
// 	    'INITIAL': { to: 'state1', },
// 	    'state1':  { to: 'INITIAL', },
// 	    'state2':  { to: 'INITIAL', },
//         }

//         prop.stateMachine[`EVENT_TYPE_B_${id}`] = {
// 	    params: ['someid'],
// 	    'state1':  { to: 'state2', },
// 	    'state2':  { to: 'state1', },
//         }

//         prop.stateMachine[`EVENT_TYPE_C_${id}`] = {
// 	    params: ['someid'],
// 	    'INITIAL': { to: 'SUCCESS', },
//             'state1' : { to: 'SUCCESS', },
//             'state2' : { to: 'FAILURE', },
//         }

//         return prop;
//     };

//     const p = createProp(13);

//     const util = require('util');

//     // console.log(util.inspect(p));

//     console.log(getTerminatingTransitions(p));

//     const rwprops = [{
//         name: 'gdpr7',
//         quantifiedVariables: ['user'],
//         projections: [['user']],
//         stateMachine: {
//             'GOT_CONSENT': {
//                 params: [
//                     'user'
//                 ],
//                 'INITIAL' : {
//                     to: 'consented'
//                 },
//             },
//             'REVOKED_CONSENT': {
//                 params: [
//                     'user'
//                 ],
//                 'consented': {
//                     to: 'INITIAL'
//                 }
//             },

//             'PROCESSING_DATA': {
//                 params: [
//                     'user'
//                 ],
//                 'INITIAL': {
//                     to: 'FAILURE'
//                 },
//                 'consented': {
//                     to: 'SUCCESS'
//                 }
//             },
//         }
//     },
//     {
//         name: 'tests-i',
//         quantifiedVariables: ['article_slug', 'user'],
//         projections: [['user'], ['article_slug', 'user']],
//         stateMachine: {
//             'LOGGED_IN': {
//                 params: ['user'],
//                 'INITIAL' : {
//                     to: 'logged-in'
//                 },
//             },
//             'LOGGED_OUT': {
//                 params: ['user'],
//                 'logged-in' : {
//                     to: 'INITIAL'
//                 },
//             },
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug', 'user'],
//                 'INITIAL' : {
//                     to: 'FAILURE'
//                 },
//                 'logged-in' : {
//                     to: 'SUCCESS'
//                 },
//             },
//         }
//     },
//     {
//         name: 'tests-ii',
//         quantifiedVariables: ['article_slug'],
//         projections: [['article_slug']],
//         stateMachine: {
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug'],
//                 'INITIAL': {
//                     to: 'published'
//                 },
//             },
//             'DELETED_ARTICLE': {
//                 params: ['article_slug'],
//                 'published' : {
//                     to: 'INITIAL'
//                 },
//             },
//             'RETRIEVED_ARTICLE': {
//                 params: ['article_slug'],
//                 'INITIAL': {
//                     to: 'FAILURE'
//                 },
//                 'published' : {
//                     to: 'SUCCESS'
//                 },
//             },
//         }
//     },
//     {
//         name: 'tests-iii',
//         quantifiedVariables: ['article_slug', 'user'],
//         projections: [['article_slug', 'user'], ['user']],
//         stateMachine: {
//             'LOGGED_IN': {
//                 params: ['user'],
//                 'INITIAL' : {
//                     to: 'logged-in'
//                 },
//                 'published-logged-out': {
//                     to: 'published'
//                 }
//             },
//             'LOGGED_OUT': {
//                 params: ['user'],
//                 'logged-in' : {
//                     to: 'INITIAL'
//                 },
//                 'published': {
//                     to: 'published-logged-out'
//                 }
//             },
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug', 'user'],
//                 'INITIAL': {
//                     to: 'FAILURE'
//                 },
//                 'logged-in': {
//                     to: 'published'
//                 }
//             },
//             'DELETED_ARTICLE': {
//                 params: ['article_slug', 'user'],
//                 'published' : {
//                     to: 'deleted'
//                 },
//                 'logged-in': {
//                     to: 'FAILURE'
//                 },
//                 'INITIAL': {
//                     to: 'FAILURE'
//                 },
//                 'published-logged-out': {
//                     to: 'FAILURE'
//                 },
//                 'deleted': {
//                     to: 'FAILURE'
//                 }
//             },
//         }
//     },
//     {
//         name: 'tests-iv',
//         quantifiedVariables: ['article_slug', 'user'],
//         projections: [['article_slug', 'user'], ['user']],
//         stateMachine: {
//             'LOGGED_IN': {
//                 params: ['user'],
//                 'INITIAL' : {
//                     to: 'logged-in'
//                 },
//                 'published': {
//                     to: 'published-logged-in'
//                 }
//             },
//             'LOGGED_OUT': {
//                 params: ['user'],
//                 'logged-in' : {
//                     to: 'INITIAL'
//                 },
//                 'published-logged-in': {
//                     to: 'published'
//                 }
//             },
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug'],
//                 'INITIAL': {
//                     to: 'published'
//                 },
//                 'logged-in': {
//                     to: 'published-logged-in'
//                 }
//             },
//             'DELETED_ARTICLE': {
//                 params: ['article_slug'],
//                 'published-logged-in' : {
//                     to: 'logged-in'
//                 },
//                 'published': {
//                     to: 'INITIAL'
//                 },
//             },
//             'FAVED': {
//                 params: ['article_slug', 'user'],
//                 'published-logged-in': {
//                     to: 'SUCCESS'
//                 },
//                 'published': {
//                     to: 'FAILURE'
//                 },
//                 'INITIAL': {
//                     to: 'FAILURE'
//                 },
//                 'logged-in': {
//                     to: 'FAILURE'
//                 }
//             }
//         }
//     },
//     {
//         name: 'tests-vi',
//         quantifiedVariables: ['article_slug'],
//         projections: [['article_slug']],
//         stateMachine: {
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug'],
//                 'INITIAL': {
//                     to: 'published'
//                 },
//             },
//             'LISTED': {
//                 params: ['article_slug'],
//                 'INITIAL': {
//                     to: 'FAILURE'
//                 },
//                 'published': {
//                     to: 'SUCCESS'
//                 },
//             },
//             'DELETED_ARTICLE': {
//                 params: ['article_slug'],
//                 'published': {
//                     to: 'INITIAL'
//                 },
//             },
//         },
//     },
//     // This is an interesting example for the chain properties thing.
//     {
//         name: 'tests-vii',
//         quantifiedVariables: ['article_slug', 'user', 'reader'],
//         projections: [['article_slug', 'user', 'reader'], ['article_slug', 'user'], ['article_slug'],['user','reader']],
//         stateMachine: {
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug', 'user'],
//                 'INITIAL': { to: 'published' },
//                 'followed': { to: 'published_and_followed' },
//             },
//             'DELETED_ARTICLE': {
//                 params: ['article_slug'],
//                 'published': { to: 'INITIAL' },
//                 'published_and_followed': { to: 'followed' },
//             },
//             'FOLLOWED': {
//                 params: ['user', 'reader'],
//                 'INITIAL': {to: 'followed'},
//                 'published': {to: 'published_and_followed'},
//             },
//             'UNFOLLOWED': {
//                 params: ['user', 'reader'],
//                 'followed': {to: 'INITIAL'},
//                 'published_and_followed': {to: 'published'},
//             },
//             'IN_FEED': { // The author id is actually not really necessary here.
//                 // Can do without it, need it for the property condition.
//                 params: ['article_slug', 'user', 'reader'],
//                 'INITIAL': { to: 'FAILURE' },
//                 'published': { to: 'FAILURE' },
//                 'followed': {to: 'FAILURE'},
//                 'published_and_followed': {to: 'SUCCESS'},
//             },
//         },
//     },
//     {
//         name: 'tests-viii',
//         quantifiedVariables: ['article_slug', 'comment_uuid', 'user'],
//         projections: [['article_slug', 'comment_uuid', 'user'], ['article_slug'], ['user']],
//         stateMachine: {
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug'],
//                 'INITIAL': { to: 'published' },
//                 'logged-in' : { to: 'published-and-logged-in' },
//             },
//             'DELETED_ARTICLE': {
//                 params: ['article_slug'],
//                 'published': { to: 'INITIAL' },
//                 'published-and-logged-in' : { to: 'logged-in' },
//             },
//             'LOGGED_IN': {
//                 params: ['user'],
//                 'INITIAL' : { to: 'logged-in' },
//                 'published': { to: 'published-and-logged-in' },
//             },
//             'LOGGED_OUT': {
//                 params: ['user'],
//                 'logged-in' : { to: 'INITIAL' },
//                 'published-and-logged-in': { to: 'published' },
//             },
//             'COMMENTED': {
//                 params: ['article_slug', 'comment_uuid', 'user'],
//                 'INITIAL': { to: 'FAILURE' },
//                 'logged-in': { to: 'FAILURE' },
//                 'published': { to: 'FAILURE' },
//                 'published-and-logged-in': { to: 'SUCCESS' },
//             },
//         },
//     },
//     {
//         name: 'tests-ix',
//         quantifiedVariables: ['article_slug', 'comment_uuid'],
//         projections: [['article_slug', 'comment_uuid'], ['article_slug']],
//         stateMachine: {
//             'PUBLISHED_ARTICLE': {
//                 params: ['article_slug'],
//                 'INITIAL': { to: 'published' },
//             },
//             'DELETED_ARTICLE': {
//                 params: ['article_slug'],
//                 'published': { to: 'INITIAL' },
//             },
//             'COMMENTED': {
//                 params: ['article_slug', 'comment_uuid'],
//                 'INITIAL': { to: 'FAILURE' },
//                 'published': { to: 'commented' },
//             },
//             'DELETED_COMMENT': {
//                 params: ['article_slug', 'comment_uuid'],
//                 'INITIAL': { to: 'FAILURE' },
//                 'commented': { to: 'SUCCESS' }, // won't get the same comment id twice
//                 // 'published': { to: 'FAILURE' },
//             },
//             'RETRIEVED_COMMENT': {
//                 params: ['article_slug', 'comment_uuid'],
//                 'INITIAL': { to: 'FAILURE' },
//                 'published': { to: 'FAILURE' },
//     		'commented': { to: 'SUCCESS' },
//             }
//         },
//     }];

//     console.log(rwprops.map(pr => getTerminatingTransitions(pr)));

// }
