const recorder = require('watchtower-recorder');
const publisher = recorder.createEventPublisher();

let context;
let lambdaExecutionContext;
let lambdaInputEvent;
function updateContext(name, event, lambdaContext) {
    context = name;
    lambdaExecutionContext = lambdaContext;
    lambdaInputEvent = event;
}

const mock = {
    'dummy': {
	operation: () => {
            return publisher({name: 'DUMMY_EVENT', params: {}}, lambdaExecutionContext);
	},
    },
};

module.exports.hello = recorder.createRecordingHandler('handler.js', 'hello' , mock, false, updateContext);
