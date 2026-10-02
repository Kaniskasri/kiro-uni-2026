// MessagingStack snapshot tests
// Validates: DLQ configs (maxReceiveCount=3), CloudWatch alarm thresholds, SNS topic
// Requirements: 19.3, 21.5

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MessagingStack } from '../lib/stacks/MessagingStack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new MessagingStack(app, 'TestMessagingStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

describe('MessagingStack', () => {
  it('matches snapshot', () => {
    expect(buildTemplate().toJSON()).toMatchSnapshot();
  });

  it('creates 6 SQS queues (3 main + 3 DLQs)', () => {
    // notification-queue, report-queue, ai-request-queue + their DLQs
    buildTemplate().resourceCountIs('AWS::SQS::Queue', 6);
  });

  it('notification-queue has DLQ with maxReceiveCount=3', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'notification-queue',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  it('report-queue has DLQ with maxReceiveCount=3', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'report-queue',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  it('ai-request-queue has DLQ with maxReceiveCount=3', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'ai-request-queue',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  it('DLQ queues exist with correct names', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'notification-dlq' });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'report-dlq' });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'ai-request-dlq' });
  });

  it('creates SNS topic for email dispatch', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'clois-email-topic',
    });
  });

  it('creates 3 CloudWatch DLQ depth alarms with threshold=0', () => {
    const template = buildTemplate();
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: {
        Threshold: 0,
        ComparisonOperator: 'GreaterThanThreshold',
      },
    });
    // At least 3 DLQ alarms
    expect(Object.keys(alarms).length).toBeGreaterThanOrEqual(3);
  });

  it('all DLQ alarms use ApproximateNumberOfMessagesVisible metric', () => {
    const template = buildTemplate();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const dlqAlarms = Object.values(alarms).filter((a) => {
      const props = (a as { Properties: Record<string, unknown> }).Properties;
      return (
        (props['MetricName'] as string | undefined) === 'ApproximateNumberOfMessagesVisible'
      );
    });
    expect(dlqAlarms.length).toBeGreaterThanOrEqual(3);
  });

  it('all SQS queues use SQS-managed encryption', () => {
    const template = buildTemplate();
    const queues = template.findResources('AWS::SQS::Queue');
    for (const queue of Object.values(queues)) {
      const props = (queue as { Properties: Record<string, unknown> }).Properties;
      // SQS managed encryption uses SqsManagedSseEnabled=true or KmsMasterKeyId='alias/aws/sqs'
      // CDK sets SqsManagedSseEnabled for SQS_MANAGED
      const sseEnabled = props['SqsManagedSseEnabled'];
      const kmsKey = props['KmsMasterKeyId'];
      expect(sseEnabled === true || kmsKey !== undefined).toBe(true);
    }
  });
});
