import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  readonly notificationDlq: sqs.IQueue;
  readonly reportDlq: sqs.IQueue;
  readonly aiRequestDlq: sqs.IQueue;
  readonly mainTable: dynamodb.ITable;
}

/**
 * MonitoringStack
 *
 * Provisions CloudWatch alarms for:
 *  - Lambda error rate > 1% (aggregate across all functions via namespace filter)
 *  - DLQ messages > 0 (per queue)
 *  - DynamoDB system errors (throttles) > 0 on the main table
 *  - Circuit breaker open (custom metric published by Lambda middleware)
 *  - Step Functions execution failures > 0
 */
export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { notificationDlq, reportDlq, aiRequestDlq, mainTable } = props;

    // ─── Lambda error rate > 1% ───────────────────────────────────────────────
    // Uses the AWS/Lambda namespace aggregate metric across all functions.
    const lambdaErrors = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const lambdaInvocations = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Invocations',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const lambdaErrorRate = new cloudwatch.MathExpression({
      expression: '(errors / invocations) * 100',
      usingMetrics: {
        errors: lambdaErrors,
        invocations: lambdaInvocations,
      },
      period: cdk.Duration.minutes(5),
      label: 'Lambda Error Rate (%)',
    });

    new cloudwatch.Alarm(this, 'LambdaErrorRateAlarm', {
      alarmName: 'clois-lambda-error-rate',
      alarmDescription: 'Lambda error rate has exceeded 1%',
      metric: lambdaErrorRate,
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ─── DLQ depth > 0 (per queue) ────────────────────────────────────────────
    const dlqAlarmDefaults = {
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    };

    new cloudwatch.Alarm(this, 'NotificationDlqAlarm', {
      alarmName: 'clois-monitoring-notification-dlq',
      alarmDescription: 'Notification DLQ has messages',
      metric: notificationDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      ...dlqAlarmDefaults,
    });

    new cloudwatch.Alarm(this, 'ReportDlqAlarm', {
      alarmName: 'clois-monitoring-report-dlq',
      alarmDescription: 'Report DLQ has messages',
      metric: reportDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      ...dlqAlarmDefaults,
    });

    new cloudwatch.Alarm(this, 'AiRequestDlqAlarm', {
      alarmName: 'clois-monitoring-ai-request-dlq',
      alarmDescription: 'AI request DLQ has messages',
      metric: aiRequestDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      ...dlqAlarmDefaults,
    });

    // ─── DynamoDB throttles > 0 ───────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'DynamoDbThrottlesAlarm', {
      alarmName: 'clois-dynamodb-throttles',
      alarmDescription: 'DynamoDB throttle events detected on clois-main',
      metric: mainTable.metricThrottledRequestsForOperations({
        operations: [
          dynamodb.Operation.GET_ITEM,
          dynamodb.Operation.PUT_ITEM,
          dynamodb.Operation.QUERY,
          dynamodb.Operation.UPDATE_ITEM,
        ],
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ─── Circuit breaker open (custom metric) ─────────────────────────────────
    // Lambda circuit breaker middleware publishes to this custom namespace/metric.
    new cloudwatch.Alarm(this, 'CircuitBreakerOpenAlarm', {
      alarmName: 'clois-circuit-breaker-open',
      alarmDescription: 'Bedrock circuit breaker has opened (5 consecutive failures)',
      metric: new cloudwatch.Metric({
        namespace: 'CLOIS/CircuitBreaker',
        metricName: 'CircuitOpen',
        dimensionsMap: { Service: 'bedrock' },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ─── Step Functions execution failures > 0 ────────────────────────────────
    new cloudwatch.Alarm(this, 'StepFunctionsFailuresAlarm', {
      alarmName: 'clois-stepfunctions-failures',
      alarmDescription: 'Step Functions executions have failed',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/States',
        metricName: 'ExecutionsFailed',
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
