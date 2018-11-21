#! /bin/bash

NODE_VERSION=8.10.0

echo "Checking for Node version ${NODE_VERSION}"
node --version | grep ${NODE_VERSION}
if [[ $? != 0 ]] ; then
    >&2 echo "Unexpected node version. Currently, the only supported version is 8.10.0."
    exit 1
fi

echo "Deploying project modules"

pushd get-and-store-random-photo/ && sls deploy -v && popd && \
  pushd feature-extraction/ && sls deploy -v && popd && \
  pushd process/ && sls deploy -v && popd && \
  pushd log-ingestion-instance/ && sls deploy -v && popd

