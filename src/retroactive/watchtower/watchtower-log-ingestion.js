const ingestion = require('watchtower-log-ingestion');
const properties = require('./watchtower-property');

module.exports.handler = ingestion.createIngestionHandler(properties);
