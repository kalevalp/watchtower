#! /bin/bash

nvm use 8.10
pushd process/ && sls remove -v && popd && pushd get-and-store-random-photo/ && sls remove -v && popd && pushd feature-extraction/ && sls remove -v && popd 
