#! /bin/bash

nvm use 8.10
pushd get-and-store-random-photo/ && sls deploy -v && popd && pushd feature-extraction/ && sls deploy -v && popd && pushd process/ && sls deploy -v && popd

