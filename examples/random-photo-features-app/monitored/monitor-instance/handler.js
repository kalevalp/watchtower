const {monitorFactory} = require('log-scan-monitor');
const {kinesisListenerFactory} = require('kinesis-listener');
const eventTable = process.env['EVENT_TABLE'];
const property = require('./build/property');

module.exports.handler = kinesisListenerFactory(monitorFactory(eventTable, property));
