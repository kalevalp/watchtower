const ingestion = require('log-ingestion');
const eventTable = process.env['EVENT_TABLE'];
const property = require('./build/property');

module.exports.handler = ingestion.createIngestionHandler(eventTable, [property]);