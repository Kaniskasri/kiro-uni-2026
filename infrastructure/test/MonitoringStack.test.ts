// MonitoringStack snapshot tests
// Validates: CloudWatch alarm thresholds, Lambda error rate, DynamoDB throttles,
//            circuit breaker, Step Functions failures
// Requirements: 19.3, 21.5

import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MonitoringStack } from '../lib/stacks/MonitoringStack';

function buildTemplate(): Template {
  const app = new cdk.App();

  // Stub dependency stack
  const depStack = new cdk.Stack(app, 'TestDepStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const notificationDlq = new sqs.Queue(depStack, 'NotificationDlq', { queueName: 'notification-dlq' });
  const reportDlq = new sqs.Queue(depStack, 'ReportDlq', { queueName: 'report-dlq' });
  const aiRequestDlq = new sqs.Queue(depStack, 'AiRequestDlq', { queueName: 'ai-request-dlq' });
  const mainTable = new dynamodb.Table(depStack, 'MainTable', {
    tableName: 'clois-main',
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  });

  const stack = new MonitoringStack(app, 'TestMonitoringStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    notificationDlq,
    reportDlq,
    aiRequestDlq,
    mainTable,
  });

  return Template.fromStack(stack);
}

describe('MonitoringStack', () => {
  it('matches snapshot', () => {
    expect(buildTemplate().toJSON()).toMatchSnapshot();
  });

  it('creates CloudWatch alarm for Lambda error rate > 1%', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'clois-lambda-error-rate',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('Lambda error rate alarm uses math expression over errors and invocations', () => {
    const template = buildTemplate();
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: { AlarmName: 'clois-lambda-error-rate' },
    });
    const alarm = Object.values(alarms)[0] as { Properties: Record<string, unknown> };
    // MathExpression alarms have Metrics array instead of a single MetricName
    const metrics = alarm.Properties['Metrics'] as unknown[] | undefined;
    expect(metrics).toBeDefined();
    expect((metrics ?? []).length).toBeGreaterThan(1);
  });

  it('creates alarm for notification DLQ', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'clois-monitoring-notification-dlq',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('creates alarm for report DLQ', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'clois-monitoring-report-dlq',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('creates alarm for AI request DLQ', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'clois-monitoring-ai-request-dlq',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('creates DynamoDB throttles alarm with threshold=0', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'clois-dynamodb-throttles',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('creates circuit breaker open alarm on CLOIS/CircuitBreaker namespace', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'clois-circuit-breaker-open',
      Namespace: 'CLOIS/CircuitBreaker',
      MetricName: 'CircuitOpen',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('creates Step Functions failures alarm on AWS/States namespace', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'clois-stepfunctions-failures',
      Namespace: 'AWS/States',
      MetricName: 'ExecutionsFailed',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  it('all alarms use MISSING_NOT_BREACHING treatment', () => {
    const template = buildTemplate();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarms)) {
      const props = (alarm as { Properties: Record<string, unknown> }).Properties;
      expect(props['TreatMissingData']).toBe('notBreaching');
    }
  });
});
