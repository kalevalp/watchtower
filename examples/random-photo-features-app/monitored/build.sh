#! /bin/bash

NODE_VERSION=8.10.0

echo "Checking for Node version ${NODE_VERSION}"
node --version | grep ${NODE_VERSION}
if [[ $? != 0 ]] ; then
    >&2 echo "Unexpected node version. Currently, the only supported version is 8.10.0."
    exit 1
fi

echo "Building project modules"

pushd get-and-store-random-photo/ && npm install && popd && \
  pushd feature-extraction/ && npm install && popd && \
  pushd process/ && npm install && popd && \
  pushd log-ingestion-instance/ && mkdir build && cp ../property.js build/ && npm install && popd
  pushd monitor-instance/ && mkdir build && cp ../property.js build/ && npm install && popd

