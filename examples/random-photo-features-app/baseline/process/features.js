'use strict';

const fs = require('fs');
const yaml = require('js-yaml');

module.exports = {
    shim: () => {
        const features = yaml.safeLoad(fs.readFileSync('./features.yml', 'utf8'));
        return JSON.stringify(features)
    },
};