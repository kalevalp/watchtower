function kinesisListenerFactory (handleMonitorInstance) {
    return (event) => {
        const monitorInstances = [];
        for (const record of event.Records) {
            let inst = JSON.parse(Buffer.from(record.kinesis.data,'base64').toString());

            monitorInstances.push(handleMonitorInstance(inst));
        }

        return Promise.all(monitorInstances)
    }
}

module.exports.kinesisListenerFactory = kinesisListenerFactory;
