# A Watchtower Deployment Package

This package contains the configuration files required for integrating
watchtower into a serverless application.

## Package Contents

* `serverless.yml`
* `watchtower/`
    * `ddbTables.yml`
    * `functions.yml`
    * `iamRoles.yml`
    * `kinesisStreams.yml`
    * `outputs.yml`
    * `stateMachine.yml`
    * `watchtower-log-ingestion.js`
    * `watchtower-monitor.js`
    * `watchtower-monitor-trigger.js`
    * `watchtower-property.js`

## Installation Instructions

1. Copy the `watchtower` directory and all of its contents into your
   application directory.

2. Write your correctness properties in
   `watchtower/watchtower-property.js`.

3. Add all of the components in the `serverless.yml` file to your
   application's `serverless.yml` file. A breakdown of the components
   that should be added follows.

## The `serverless.yml` File

The following components should be added to your `serverless.yml` file:

### General settings and configuration

Watchtower is only supported on AWS Lamdbda, running Node.js
serverless applications. Currently supported runtimes are `nodejs10.x`
and `nodejs12.x`.

### `provider.environment`

The `WATCHTOWER_EVENT_KINESIS_STREAM` env variable is used to
propagate the name of the event kinesis stream to the

The `DEBUG_WATCHTOWER` and `PROFILE_WATCHTOWER` env variables are used
to provide debug and timing prints.

### `functions`

The following functions need to be declared:

* watchtower-ingestion &ndash; a function that consumes event
  published on the kinesis stream, processes, and stores the processed
  events in a dynamodb table

* watchtower-monitor &ndash; a function that checks the correctness
  properties

* wt-monitor-trigger &ndash; a function that triggers the checking and
  delay state machine


### `resources.Resources`
The following resources need to be declared:

* EventsTable &ndash; A DynamoDB table used to store the processed
  events

* CheckpointsTable &ndash; A DynamoDB table used to store monitor
  checkpoints reached by the checker

* InvocationStream &ndash; A Kinesis stream used to trigger the
  checker

* EventsStream &ndash; A Kinesis stream used by the recorder to
  publish events

* EventWriterRole &ndash; An iam role allowing the ingestion function
  to write to the events table

* EventReaderRole &ndash; An iam role allowing the checker function to
  read from the events table

* StateMachineListExec &ndash; An iam role allowing the trigger
  function to start state machine executions

### `resources.Outputs`
The following output needs to be declared:

* `WTCheckerMachine` &ndash; The name of the checker flow state
  machine

### `custom`

You can optionally add the `custom.handlerFilePostfix` option to
easily switch between the monitored and not monitored variants of your
application. To properly use it, the wrapped handler files should be
called `<original-handler-file-name>-wrapper`.

### `stepFunctions.stateMachines`

The `checker` state machine needs to be declared. The state machine is
tasked with running the checker after the appropriate delay.
