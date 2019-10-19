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

module.exports = property;
