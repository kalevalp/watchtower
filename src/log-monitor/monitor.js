"use strict";

const zlib = require('zlib');

// const propertiesRE = /#####PROPERTIES\[([A-Za-z0-9,]*)]#####/;
const eventUpdateRE = /^#####EVENTUPDATE\[([A-Za-z0-9,()\-_]*)]#####$/;
// const removeRE = /___REMOVE___/;
// const addRE = /___ADD___/;

let property;

module.exports.setProperty = function(prop) {
    property = prop;
};


module.exports.handler = function(event, context, callback) {
    if (!property) {
        callback("Error, no property defined at monitor!");
    } else {
        const payload = new Buffer(event.awslogs.data, 'base64');
        zlib.gunzip(payload, function (e, result) {
            if (e) {
                callback(true);
            } else {
                result = JSON.parse(result.toString('ascii'));
                for (const logEvent in result.logEvents) {
                    // const properties = logEvent.match(propertiesRE)[1].split(',');
                    const eventUpdate = logEvent.match(eventUpdateRE)[1];

                    property.event(eventUpdate);
                }
                // console.log("Event Data:", JSON.stringify(result, null, 2));
                callback(null);
            }
        });
    }
};
