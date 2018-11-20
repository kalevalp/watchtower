const ingestion = require('log-ingestion');

const eventTable = process.env['EVENT_TABLE'];

module.exports.handler = ingestion.createIngestionHandler(eventTable);