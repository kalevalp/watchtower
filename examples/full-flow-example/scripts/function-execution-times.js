const log_scraper = require('cloudwatch-log-scraper');
const fs = require('fs');

const scraper = new log_scraper.LogScraper('eu-west-1');

function getRandFname() {
    const fiveDigitID = Math.floor(Math.random() * Math.floor(99999));
    return `runResults-${fiveDigitID}`;
}

async function main() {
    let lgs = await scraper.getAllLogGroups();
    lgs = lgs.filter(item => item.match(/wt-no-params-.*-hello/));

    function getRunAnalysis(logEvent) {

	const runReportRE = /REPORT RequestId: [0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\tDuration: ([0-9]*\.[0-9]*) ms/;
        const initReportRE = /Init Duration: ([0-9]*\.[0-9]*) ms/;

        res = {
            runTime: logEvent.match(runReportRE)[1],
        };

        if (logEvent.match(initReportRE)) {
            res.isInit = true;
            res.initTime = logEvent.match(initReportRE)[1];
        } else {
            res.isInit = false;
        }

        return res;
    }

    const runResults = [];

    for (const logGroup of lgs) { // Should be just one.
        const fname = 'hello';
	const logElements = await scraper.getAllLogItemsForGroup(logGroup);
	const reportLog = logElements.filter(x => x.message.match(/REPORT RequestId:/));

	for (const logEvent of reportLog) {
	    const runAnalysis = getRunAnalysis(logEvent.message);
            runAnalysis.fname = fname;
            runResults.push(runAnalysis);

//          const invocationReport = `${fname}, ${runAnalysis.runTime}, ${runAnalysis.isInit}`.concat(runAnalysis.isInit ? `, ${runAnalysis.initTime}` : '');

//	    console.log(invocationReport);
	}
    }

    let outputfname = getRandFname();

    if (process.argv[2]) {
        outputfname = process.argv[2];
    }

    fs.writeFileSync(outputfname, JSON.stringify(runResults));

    // for (const violation of violationLog) {
    //     const violationDetails = violation.message.match(violatingInvocationRE)[1]

    //     const violatingEvent = articleCreateEvents.find(x => x.message.match(violationDetails))
    //     console.log(`Time of violating event: ${violatingEvent.timestamp}, time of violation detection: ${violation.timestamp}, delay: ${violation.timestamp-violatingEvent.timestamp}(ms).`);
    // }

    // console.log(articleCreateLog.filter(x => x.message.match(/EVENTUPDATE/)));
}

main();


//console.log(process.argv);
