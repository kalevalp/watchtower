const replayer = require('watchtower-replayer');

const consumeHandler = replayer.createReplayHandler('handler.js', 'consume')
const produceHandler = replayer.createReplayHandler('handler.js', 'produce')

module.exports = {consumeHandler, produceHandler};

if (require.main === module) {
    const execId = process.argv[2];

    replayAsyncHandler(execId, produceHandler, 'wtrnrbucket');
}
