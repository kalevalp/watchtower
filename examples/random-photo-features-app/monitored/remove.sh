#! /bin/bash

NODE_VERSION=8.10.0

echo "Checking for Node version ${NODE_VERSION}"
node --version | grep ${NODE_VERSION}
if [[ $? != 0 ]] ; then
    >&2 echo "Unexpected node version. Currently, the only supported version is 8.10.0."
    exit 1
fi

echo "Removing project modules"

pushd log-ingestion-instance/ && sls remove -v && popd && \
  pushd monitor-instance/ && sls remove -v && popd && \
  pushd invocation-stream && sls remove -v && popd && \
  pushd process/ && sls remove -v && popd && \
  pushd get-and-store-random-photo/ && sls remove -v && popd && \
  pushd feature-extraction/ && sls remove -v && popd
