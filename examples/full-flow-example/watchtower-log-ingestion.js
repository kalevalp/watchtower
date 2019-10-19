const ingestion = require('watchtower-log-ingestion');
const property = require('./watchtower-property');

module.exports.handler = ingestion.createIngestionHandler([property]);
