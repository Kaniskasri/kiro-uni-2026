#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/stacks/DatabaseStack';
import { StorageStack } from '../lib/stacks/StorageStack';
import { AuthStack } from '../lib/stacks/AuthStack';
import { MessagingStack } from '../lib/stacks/MessagingStack';
import { CdnStack } from '../lib/stacks/CdnStack';
import { MonitoringStack } from '../lib/stacks/MonitoringStack';
import { WorkflowStack } from '../lib/stacks/WorkflowStack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const databaseStack = new DatabaseStack(app, 'CloisDatabaseStack', { env });
const storageStack = new StorageStack(app, 'CloisStorageStack', { env });
const authStack = new AuthStack(app, 'CloisAuthStack', { env });
const messagingStack = new MessagingStack(app, 'CloisMessagingStack', { env });

const cdnStack = new CdnStack(app, 'CloisCdnStack', {
  env,
  frontendBucket: storageStack.frontendBucket,
});

new MonitoringStack(app, 'CloisMonitoringStack', {
  env,
  notificationDlq: messagingStack.notificationDlq,
  reportDlq: messagingStack.reportDlq,
  aiRequestDlq: messagingStack.aiRequestDlq,
  mainTable: databaseStack.mainTable,
});

new WorkflowStack(app, 'CloisWorkflowStack', {
  env,
  mainTable: databaseStack.mainTable,
  auditLogTable: databaseStack.auditLogTable,
  notificationQueue: messagingStack.notificationQueue,
  assetsBucket: storageStack.assetsBucket,
});

// Suppress unused variable warnings for stacks consumed by future tasks
void authStack;
void cdnStack;
