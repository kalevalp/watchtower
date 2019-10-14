const ingestion = require('watchtower-log-ingestion');
const eventTable = process.env['WATCHTOWER_EVENT_TABLE'];
const instanceTable = process.env['WATCHTOWER_PROPERTY_INSTANCE_TABLE'];
const property = require('./watchtower-property');

module.exports.handler = ingestion.createIngestionHandler(eventTable, [property]);
