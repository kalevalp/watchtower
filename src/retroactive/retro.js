const aws = require('aws-sdk');
const recorder = require('watchtower-recorder');


const kinesisStream = process.env.WATCHTOWER_KINESIS_STREAM;
const debug = process.env.DEBUG_WATCHTOWER;
const s3BucketName = process.env.WATCHTOWER_RAW_DATA_BUCKET;

const publisher = recorder.createEventPublisher(kinesisStream, true);
const s3 = new aws.S3();


async function runRetroactiveChecker(conditions) {
    // TODO - handle history larger than 1000 objects
    const executionHistory = (await s3.listObjects({Bucket: s3BucketName, Prefix: 'exec--'}).promise()).Contents;

    // console.log(history);

    const execRE = /exec--(.*)--(.*)/;

    const orderedExecs = executionHistory
          .map(item => ({key: item.Key,
                         timestamp: Number(item.Key.match(execRE)[1]),
                         execID: item.Key.match(execRE)[2],
                        }))
          .sort((a,b) => a-b)
          .map(item => item.execID);


    console.log(orderedExecs);

    for (const exec of orderedExecs) {
        const runHistory = await s3.listObjects({Bucket: s3BucketName, Prefix: exec}).promise();

        // console.log(history);

        const hist = await Promise.all(runHistory.Contents
                                       .map(item => item.Key)
                                       .map(async Key => (
                                           {
                                               key: Key,
                                               item: JSON.parse(((await s3.getObject({Key, Bucket: s3BucketName}).promise()).Body.toString()))
                                           })))

        const order = hist.find(elem => elem.item.idx === 'opTO').item.data.operationTotalOrder.filter(elem => elem.type === 'RESPONSE');
        const eventTrigger = hist.find(elem => elem.item.idx === 'event-context').item.data;

        const eventsInRespOrder = order.map(elem => ({req: hist.find(e => e.item.idx === `${elem.idx}-req`).item,
                                                      resp: hist.find(e => e.item.idx === elem.idx).item}))
        for (const event of eventsInRespOrder) {
            const wtEvent = conditions.find(cond => cond.check(event, eventTrigger)).toEvent(event, eventTrigger);
            publisher(wtEvent, eventTrigger.context, event.resp.now);
        }
    }
}

module.exports.runRetroactiveChecker = runRetroactiveChecker;

if (require.main === module) {
    const conditions = [
        {
            check: (event, eventTrigger) =>
                eventTrigger.handlerName === 'produce' &&
                event.req.data.fname === 'put',
            toEvent: (event, eventTrigger) => ({
                name: 'WROTE_LOREM',
                params: {
                        hash: event.req.data.argumentsList[0].Item.digest,
                }
            }),
        },
    ]

    runRetroactiveChecker(conditions);
}
