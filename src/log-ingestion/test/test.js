if (process.argv[2] === "test") {
    const input = {
        "Records": [
            {
                "kinesis": {
                    "kinesisSchemaVersion": "1.0",
                    "partitionKey": "wt-no-params-test-hello",
                    "sequenceNumber": "49600591983576441710715867822834067253867309126245154914",
                    "data": "eyJsb2dFdmVudCI6eyJuYW1lIjoiRFVNTVlfRVZFTlRfVFlQRV9BIiwicGFyYW1zIjp7ImV2ZW50aWQiOiJhMDUwM2I0YS0xYWI5LTQ4MTItOTYwMC1mNTYxOTQwMzAxN2UifX0sInRpbWVzdGFtcCI6MTU3MTUxMzQ2MDk3OCwiaW52b2NhdGlvbklEIjoiNmNmZDkxMTUtM2YzZi00N2NjLThhYmQtNDIzM2RjZDhkNDdiIn0=",
                    "approximateArrivalTimestamp": 1571513461.084
                },
                "eventSource": "aws:kinesis",
                "eventVersion": "1.0",
                "eventID": "shardId-000000000006:49600591983576441710715867822834067253867309126245154914",
                "eventName": "aws:kinesis:record",
                "invokeIdentityArn": "arn:aws:iam::432356059652:role/testEventWriterRole",
                "awsRegion": "eu-west-1",
                "eventSourceARN": "arn:aws:kinesis:eu-west-1:432356059652:stream/WatchtowertestEventsStream"
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

    module.exports = property;


    const handler = createKinesisIngestionHandler([property]);

    handler(input, {getRemainingTimeInMillis: () => 10});
}
