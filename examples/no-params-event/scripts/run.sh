#! /bin/bash

for kind in {no-wrapper,log-events,kinesis-events}
do
    echo Running ${kind}

    pushd ../

    cp serverless.yml serverless.yml.prev
    cp serverless.yml-${kind} serverless.yml
    sls deploy -v
    API_URL=`serverless info --verbose | grep '^ServiceEndpoint:' | grep -o 'https://.*'`; export API_URL=$API_URL/microbmark

    popd

    echo -n > e2e-${kind}
    for i in {1..10}
    do
	( time curl $API_URL ) 2>> e2e-${kind}
    done

    unset API_URL

    sleep 30

    node function-execution-times.js ${kind}-times

    pushd ../

    sls remove -v

    mv serverless.yml.prev serverless.yml

    popd

done
