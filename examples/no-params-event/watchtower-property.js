const property = {
    name: 'dummy',
    quantifiedVariables: [],
    projections: [[]],
    stateMachine: {
	'DUMMY_EVENT': {
	    params: [],
	    'INITIAL': {
		to: 'FAILURE',
	    },
	},
    },
};

module.exports = property;
