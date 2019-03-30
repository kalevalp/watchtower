const {monitorFactory, kinesisListenerFactory} = require('watchtower-monitor');
const eventTable = process.env['WATCHTOWER_EVENT_TABLE'];
const property = require('./watchtower-property');
module.exports.handler = kinesisListenerFactory(monitorFactory(eventTable, property));
