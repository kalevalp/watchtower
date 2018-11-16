#! /bin/bash

nvm use 8.10
pushd get-and-store-random-photo/ && npm install && popd && pushd feature-extraction/ && npm install && popd && pushd process/ && npm install && popd

