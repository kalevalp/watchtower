const recorder = require('watchtower-recorder');

const mock = {
    'dummy'     : {
	operation: () => {
	    console.log('#####EVENTUPDATE[DUMMY_EVENT()]#####');
	},
    },
};

module.exports.hello = recorder.createRecordingHandler('handler.js', 'hello' , mock);
