'use strict';

const tableName = process.env.LOREM_DYNAMO_TABLE;

const aws = require('aws-sdk');
const crypto = require('crypto');
const { LoremIpsum } = require('lorem-ipsum');

let dynamodb = new aws.DynamoDB.DocumentClient();

const lorem = new LoremIpsum({
  sentencesPerParagraph: {
    max: 12,
    min: 4
  },
  wordsPerSentence: {
    max: 20,
    min: 8
  }
});


function wrap(data) {
    return {
        statusCode: 200,
        body: JSON.stringify(
            {
                response: data,
            },
            null,
            2
        ),
    };
}

async function produce(event, context) {
    const paraCount = Math.floor(Math.random() * 50);
    console.log(paraCount);
    const text = lorem.generateParagraphs(paraCount);

    const hash = crypto.createHash('sha256');

    hash.update(text);
    const digest = hash.digest('hex');

    // Write to DDB

    await dynamodb.put({TableName: tableName, Item: {digest, text}}).promise();

    return wrap(digest);

}

async function consume(event, context) {
    const keys = await dynamodb.scan({TableName: tableName, ProjectionExpression: 'digest'}).promise();
    const key = keys.Items[Math.floor(Math.random() * keys.Count)];

    const resp = await dynamodb.get({TableName: tableName, Key: key}).promise();
    return wrap(resp.Item.text);
}

module.exports.produce = produce;
module.exports.consume = consume;
