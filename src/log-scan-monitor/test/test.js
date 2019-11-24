const {kinesisListenerFactory, monitorFactory} = require('../monitor');

const input = {
    "Records": [
        {
            "kinesis": {
                "kinesisSchemaVersion": "1.0",
                "partitionKey": "\"{\\\"eventid\\\":\\\"9b1596b2-4b34-46e9-84ba-cd742c5d49c1\\\"}\"",
                "sequenceNumber": "49600642134495777700315066552915572419924899399074840626",
                "data": "eyJldmVudGlkIjoiOWIxNTk2YjItNGIzNC00NmU5LTg0YmEtY2Q3NDJjNWQ0OWMxIn0=",
                "approximateArrivalTimestamp": 1571654144.01
            },
            "eventSource": "aws:kinesis",
            "eventVersion": "1.0",
            "eventID": "shardId-000000000003:49600642134495777700315066552915572419924899399074840626",
            "eventName": "aws:kinesis:record",
            "invokeIdentityArn": "arn:aws:iam::432356059652:role/testEventReaderRole",
            "awsRegion": "eu-west-1",
            "eventSourceARN": "arn:aws:kinesis:eu-west-1:432356059652:stream/WatchtowertestInvocationStream"
        }
    ]
};

const property = {
    name: 'dummy',
    quantifiedVariables: ['eventid'],
    projections: [['eventid']],
    stateMachine: {
        'DUMMY_EVENT_TYPE_A': {
            params: ['eventid'],
            'INITIAL': {
                to: 'intermediate',
            },
            'intermediate': {
                to: 'SUCCESS',
            },
        },
        'DUMMY_EVENT_TYPE_B': {
            params: ['eventid'],
            'INITIAL': {
                to: 'SUCCESS',
            },
            'intermediate': {
                to: 'FAILURE',
            },
        },
    },
};

const handler = kinesisListenerFactory(monitorFactory([property]));
handler(input);
