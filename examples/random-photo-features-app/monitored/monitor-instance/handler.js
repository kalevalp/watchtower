const {monitorFactory} = require('log-scan-monitor');
const eventTable = process.env['EVENT_TABLE'];
const property = require('./build/property');

module.exports.handler = monitorFactory(eventTable, property);

