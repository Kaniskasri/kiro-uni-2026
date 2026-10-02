import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Construct } from 'constructs';

/**
 * MessagingStack
 *
 * Provisions asynchronous messaging infrastructure:
 *  - EventBridge default bus
 *  - SQS queues: notification-queue, report-queue, ai-request-queue (each with a DLQ)
 *  - SNS topic wired to SES for email dispatch
 *  - CloudWatch alarm on DLQ depth > 0 for each queue
 */
export class MessagingStack extends cdk.Stack {
  public readonly eventBus: events.EventBus;

  public readonly notificationQueue: sqs.Queue;
  public readonly reportQueue: sqs.Queue;
  public readonly aiRequestQueue: sqs.Queue;

  public readonly notificationDlq: sqs.Queue;
  public readonly reportDlq: sqs.Queue;
  public readonly aiRequestDlq: sqs.Queue;

  public readonly emailTopic: sns.Topic;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── EventBridge default bus ──────────────────────────────────────────────
    // Use the account default bus (pre-existing). We reference it for outputs.
    this.eventBus = events.EventBus.fromEventBusName(
      this,
      'DefaultEventBus',
      'default',
    ) as events.EventBus;

    // ─── Dead-letter queues ───────────────────────────────────────────────────
    this.notificationDlq = new sqs.Queue(this, 'NotificationDlq', {
      queueName: 'notification-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.reportDlq = new sqs.Queue(this, 'ReportDlq', {
      queueName: 'report-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.aiRequestDlq = new sqs.Queue(this, 'AiRequestDlq', {
      queueName: 'ai-request-dlq',
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // ─── Main queues (with DLQ after 3 failed attempts) ───────────────────────
    this.notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
      queueName: 'notification-queue',
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.notificationDlq,
        maxReceiveCount: 3,
      },
    });

    this.reportQueue = new sqs.Queue(this, 'ReportQueue', {
      queueName: 'report-queue',
      visibilityTimeout: cdk.Duration.seconds(900), // report generation can take longer
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.reportDlq,
        maxReceiveCount: 3,
      },
    });

    this.aiRequestQueue = new sqs.Queue(this, 'AiRequestQueue', {
      queueName: 'ai-request-queue',
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.aiRequestDlq,
        maxReceiveCount: 3,
      },
    });

    // ─── SNS topic for email dispatch via SES ─────────────────────────────────
    this.emailTopic = new sns.Topic(this, 'EmailTopic', {
      topicName: 'clois-email-topic',
      displayName: 'CLOIS Email Dispatch',
    });

    // Wire SNS → SES via email subscription
    // In production, SES email addresses/domains must be verified separately.
    // The SES identity is configured outside CDK (or in a dedicated SES stack).
    // Here we create the SNS→SES configuration set integration.
    const sesEmailTarget = new ses.EmailIdentity(this, 'SesEmailIdentity', {
      identity: ses.Identity.email('noreply@clois.example.com'),
    });

    // Subscribe SNS topic to an SES-compatible endpoint
    // Workers call SES directly (more reliable); SNS is used for fan-out to other consumers
    this.emailTopic.addSubscription(
      new snsSubscriptions.EmailSubscription('noreply@clois.example.com'),
    );

    // Suppress unused variable warning
    void sesEmailTarget;

    // ─── CloudWatch alarms: DLQ depth > 0 ────────────────────────────────────
    const dlqAlarmProps = {
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    };

    const notificationDlqAlarm = new cloudwatch.Alarm(this, 'NotificationDlqAlarm', {
      alarmName: 'clois-notification-dlq-depth',
      alarmDescription: 'Messages have landed in the notification DLQ',
      metric: this.notificationDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      ...dlqAlarmProps,
    });

    const reportDlqAlarm = new cloudwatch.Alarm(this, 'ReportDlqAlarm', {
      alarmName: 'clois-report-dlq-depth',
      alarmDescription: 'Messages have landed in the report DLQ',
      metric: this.reportDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      ...dlqAlarmProps,
    });

    const aiDlqAlarm = new cloudwatch.Alarm(this, 'AiRequestDlqAlarm', {
      alarmName: 'clois-ai-request-dlq-depth',
      alarmDescription: 'Messages have landed in the AI request DLQ',
      metric: this.aiRequestDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      ...dlqAlarmProps,
    });

    // Suppress unused variable warnings — alarms are self-contained resources
    void notificationDlqAlarm;
    void reportDlqAlarm;
    void aiDlqAlarm;

    // ─── Outputs ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'NotificationQueueUrl', { value: this.notificationQueue.queueUrl });
    new cdk.CfnOutput(this, 'ReportQueueUrl', { value: this.reportQueue.queueUrl });
    new cdk.CfnOutput(this, 'AiRequestQueueUrl', { value: this.aiRequestQueue.queueUrl });
    new cdk.CfnOutput(this, 'EmailTopicArn', { value: this.emailTopic.topicArn });
  }
}
