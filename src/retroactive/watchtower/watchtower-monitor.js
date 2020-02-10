const {monitorFactory, kinesisListenerFactory} = require('watchtower-monitor');
const property = require('./watchtower-property');
module.exports.handler = kinesisListenerFactory(monitorFactory(property));
