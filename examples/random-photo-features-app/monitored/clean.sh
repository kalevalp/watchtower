#! /bin/bash

NODE_VERSION=8.10.0

echo "Checking for Node version ${NODE_VERSION}"
node --version | grep ${NODE_VERSION}
if [[ $? != 0 ]] ; then
    >&2 echo "Unexpected node version. Currently, the only supported version is 8.10.0."
    exit 1
fi

echo "Cleaning project modules"

pushd get-and-store-random-photo/ && rm -rf node_modules && popd && \
  pushd feature-extraction/ && rm -rf node_modules && popd && \
  pushd process/ && rm -rf node_modules && popd && \
  pushd log-ingestion-instance && rm -rf node_modules && rm build/property.js && rmdir build && popd

