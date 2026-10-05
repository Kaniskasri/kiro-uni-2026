import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { LambdaFunction } from '../constructs/LambdaFunction';
import { StepMachine, STANDARD_RETRY } from '../constructs/StepMachine';

export interface WorkflowStackProps extends cdk.StackProps {
  readonly mainTable: dynamodb.ITable;
  readonly auditLogTable: dynamodb.ITable;
  readonly notificationQueue: sqs.IQueue;
  readonly assetsBucket: s3.IBucket;
}

/**
 * WorkflowStack
 *
 * Provisions four Step Functions state machines for CLOIS automated workflows:
 *  1. Event Publish Workflow  — ValidateEvent → ... → WriteAuditLog
 *  2. Event Cancellation Workflow — SetCancelledStatus → ... → WriteAuditLog
 *  3. Reminder Workflow — CheckReminderEligibility → ... → MarkReminderSent
 *  4. Post-Event Report Workflow — AggregateEventMetrics → ... → WriteAuditLog
 *
 * Also provisions the Scheduler Lambda that handles EventBridge T-start / T-end rules.
 *
 * Per backend-conventions: every task state uses STANDARD_RETRY (5 s / 3 attempts / 2×)
 * and every workflow has a terminal MarkWorkflowFailed catch state that writes an audit log.
 */
export class WorkflowStack extends cdk.Stack {
  /** ARN of the Scheduler Lambda (used as EventBridge rule target) */
  public readonly schedulerFnArn: string;

  /** ARN of the Event Publish State Machine */
  public readonly eventPublishSfnArn: string;

  /** ARN of the Event Cancellation State Machine */
  public readonly eventCancellationSfnArn: string;

  /** ARN of the Reminder State Machine */
  public readonly reminderSfnArn: string;

  /** ARN of the Post-Event Report State Machine */
  public readonly postEventReportSfnArn: string;

  constructor(scope: Construct, id: string, props: WorkflowStackProps) {
    super(scope, id, props);

    const { mainTable, auditLogTable, notificationQueue, assetsBucket } = props;

    const lambdaEnv: Record<string, string> = {
      MAIN_TABLE: mainTable.tableName,
      AUDIT_LOG_TABLE: auditLogTable.tableName,
      NOTIFICATION_QUEUE_URL: notificationQueue.queueUrl,
      ASSETS_BUCKET: assetsBucket.bucketName,
    };

    // ─── Lambda task functions ────────────────────────────────────────────────

    const eventPublishFn = new LambdaFunction(this, 'EventPublishFn', {
      functionName: 'workflow-event-publish',
      codePath: '../lambda/src/workflows',
      handler: 'eventPublish.validateEvent',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });

    const eventCancellationFn = new LambdaFunction(this, 'EventCancellationFn', {
      functionName: 'workflow-event-cancellation',
      codePath: '../lambda/src/workflows',
      handler: 'eventCancellation.setCancelledStatus',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });

    const reminderFn = new LambdaFunction(this, 'ReminderFn', {
      functionName: 'workflow-reminder',
      codePath: '../lambda/src/workflows',
      handler: 'reminder.checkReminderEligibility',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });

    const postEventReportFn = new LambdaFunction(this, 'PostEventReportFn', {
      functionName: 'workflow-post-event-report',
      codePath: '../lambda/src/workflows',
      handler: 'postEventReport.aggregateEventMetrics',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(300),
    });

    // ─── Scheduler Lambda ─────────────────────────────────────────────────────
    // Populated after SFN ARNs are known — use a placeholder that will be updated
    const schedulerFnConstruct = new LambdaFunction(this, 'SchedulerFn', {
      functionName: 'workflow-scheduler',
      codePath: '../lambda/src/workflows',
      handler: 'scheduler.handler',
      environment: {
        ...lambdaEnv,
        // POST_EVENT_REPORT_SFN_ARN and REMINDER_SFN_ARN set via addEnvironment below
        POST_EVENT_REPORT_SFN_ARN: '',
        REMINDER_SFN_ARN: '',
      },
      timeout: cdk.Duration.seconds(30),
    });

    this.schedulerFnArn = schedulerFnConstruct.fn.functionArn;

    // ─── IAM permissions ──────────────────────────────────────────────────────

    // Allow all workflow Lambdas to read/write main table
    for (const fnConstruct of [
      eventPublishFn,
      eventCancellationFn,
      reminderFn,
      postEventReportFn,
      schedulerFnConstruct,
    ]) {
      mainTable.grantReadWriteData(fnConstruct.fn);
      // Audit log is append-only — only PutItem
      auditLogTable.grant(fnConstruct.fn, 'dynamodb:PutItem');
      notificationQueue.grantSendMessages(fnConstruct.fn);
    }

    // EventPublish needs EventBridge PutRule + PutTargets
    eventPublishFn.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:PutRule', 'events:PutTargets'],
        resources: ['*'],
      }),
    );

    // EventCancellation needs EventBridge DeleteRule + RemoveTargets
    eventCancellationFn.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['events:DeleteRule', 'events:RemoveTargets'],
        resources: ['*'],
      }),
    );

    // PostEventReport needs S3 PutObject for reports
    assetsBucket.grantPut(postEventReportFn.fn, 'reports/*');

    // Scheduler needs SFN StartExecution + EventBridge PutRule/PutTargets
    schedulerFnConstruct.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: ['*'],
      }),
    );

    // ─── Shared MarkWorkflowFailed Lambda ─────────────────────────────────────
    // Each workflow uses its own fail-handler Lambda that writes an audit log entry.
    // We reuse the domain Lambda functions for this (they export markWorkflowFailed).

    // ─── Helper: build a LambdaInvoke task with standard retry + fail catch ───
    const buildTask = (
      id: string,
      fn: lambda.IFunction,
      failState: sfn.State,
      resultPath?: string,
    ): tasks.LambdaInvoke => {
      const task = new tasks.LambdaInvoke(this, id, {
        lambdaFunction: fn,
        outputPath: resultPath ?? '$',
        retryOnServiceExceptions: false,
      });
      task.addRetry(STANDARD_RETRY);
      task.addCatch(failState as sfn.IChainable, {
        errors: ['States.ALL'],
        resultPath: '$.error',
      });
      return task;
    };

    // ─── 1. Event Publish Workflow ────────────────────────────────────────────

    // Publish Fail Lambda
    const publishFailFn = new LambdaFunction(this, 'PublishFailFn', {
      functionName: 'workflow-publish-fail',
      codePath: '../lambda/src/workflows',
      handler: 'eventPublish.writeAuditLog',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });
    auditLogTable.grant(publishFailFn.fn, 'dynamodb:PutItem');
    mainTable.grantReadWriteData(publishFailFn.fn);
    notificationQueue.grantSendMessages(publishFailFn.fn);

    const markPublishWorkflowFailed = new tasks.LambdaInvoke(
      this,
      'MarkPublishWorkflowFailed',
      {
        lambdaFunction: publishFailFn.fn,
        outputPath: '$',
      },
    );
    markPublishWorkflowFailed.addRetry(STANDARD_RETRY);

    const publishFail = new sfn.Fail(this, 'PublishFail', {
      cause: 'Event publish workflow failed',
      error: 'WorkflowFailed',
    });

    markPublishWorkflowFailed.next(publishFail);

    const revertToDraftTask = new tasks.LambdaInvoke(this, 'RevertToDraft', {
      lambdaFunction: eventPublishFn.fn,
      outputPath: '$',
    });
    revertToDraftTask.addRetry(STANDARD_RETRY);
    revertToDraftTask.next(markPublishWorkflowFailed);

    // Build publish chain (share a single Lambda; different entry-point per step
    // is achieved by passing the step name in the payload and routing in Lambda)
    // In a production system each step would be a separate Lambda.
    // Here we use the same Lambda but pass state via the payload.
    const validateEventTask = buildTask('ValidateEvent', eventPublishFn.fn, revertToDraftTask);
    const scheduleRulesTask = buildTask('ScheduleEventBridgeRules', eventPublishFn.fn, revertToDraftTask);
    const setPublishedTask = buildTask('SetPublishedStatus', eventPublishFn.fn, revertToDraftTask);
    const scheduleRemindersTask = buildTask('ScheduleReminders', eventPublishFn.fn, revertToDraftTask);
    const emitPublishedTask = buildTask('EmitPublishedEvent', eventPublishFn.fn, revertToDraftTask);
    const publishAuditTask = buildTask('PublishWriteAuditLog', eventPublishFn.fn, revertToDraftTask);

    const publishSuccess = new sfn.Succeed(this, 'PublishSuccess');
    publishAuditTask.next(publishSuccess);
    emitPublishedTask.next(publishAuditTask);
    scheduleRemindersTask.next(emitPublishedTask);
    setPublishedTask.next(scheduleRemindersTask);
    scheduleRulesTask.next(setPublishedTask);
    validateEventTask.next(scheduleRulesTask);

    const eventPublishMachine = new StepMachine(this, 'EventPublishWorkflow', {
      machineName: 'event-publish',
      definition: validateEventTask,
    });
    this.eventPublishSfnArn = eventPublishMachine.stateMachine.stateMachineArn;

    // ─── 2. Event Cancellation Workflow ──────────────────────────────────────

    const cancellationFailFn = new LambdaFunction(this, 'CancellationFailFn', {
      functionName: 'workflow-cancellation-fail',
      codePath: '../lambda/src/workflows',
      handler: 'eventCancellation.markWorkflowFailed',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });
    auditLogTable.grant(cancellationFailFn.fn, 'dynamodb:PutItem');

    const markCancellationWorkflowFailed = new tasks.LambdaInvoke(
      this,
      'MarkCancellationWorkflowFailed',
      { lambdaFunction: cancellationFailFn.fn, outputPath: '$' },
    );
    markCancellationWorkflowFailed.addRetry(STANDARD_RETRY);

    const cancellationFail = new sfn.Fail(this, 'CancellationFail', {
      cause: 'Event cancellation workflow failed',
      error: 'WorkflowFailed',
    });
    markCancellationWorkflowFailed.next(cancellationFail);

    const setCancelledTask = buildTask(
      'SetCancelledStatus',
      eventCancellationFn.fn,
      markCancellationWorkflowFailed,
    );
    const voidTicketsTask = buildTask(
      'VoidAllTickets',
      eventCancellationFn.fn,
      markCancellationWorkflowFailed,
    );
    const enqueueNotificationsTask = buildTask(
      'EnqueueAttendeeNotifications',
      eventCancellationFn.fn,
      markCancellationWorkflowFailed,
    );
    const deleteRulesTask = buildTask(
      'DeleteEventBridgeRules',
      eventCancellationFn.fn,
      markCancellationWorkflowFailed,
    );
    const cancellationAuditTask = buildTask(
      'CancellationWriteAuditLog',
      eventCancellationFn.fn,
      markCancellationWorkflowFailed,
    );

    const cancellationSuccess = new sfn.Succeed(this, 'CancellationSuccess');
    cancellationAuditTask.next(cancellationSuccess);
    deleteRulesTask.next(cancellationAuditTask);
    enqueueNotificationsTask.next(deleteRulesTask);
    voidTicketsTask.next(enqueueNotificationsTask);
    setCancelledTask.next(voidTicketsTask);

    const eventCancellationMachine = new StepMachine(this, 'EventCancellationWorkflow', {
      machineName: 'event-cancellation',
      definition: setCancelledTask,
    });
    this.eventCancellationSfnArn =
      eventCancellationMachine.stateMachine.stateMachineArn;

    // ─── 3. Reminder Workflow ─────────────────────────────────────────────────

    const reminderFailFn = new LambdaFunction(this, 'ReminderFailFn', {
      functionName: 'workflow-reminder-fail',
      codePath: '../lambda/src/workflows',
      handler: 'reminder.markWorkflowFailed',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });
    auditLogTable.grant(reminderFailFn.fn, 'dynamodb:PutItem');

    const markReminderWorkflowFailed = new tasks.LambdaInvoke(
      this,
      'MarkReminderWorkflowFailed',
      { lambdaFunction: reminderFailFn.fn, outputPath: '$' },
    );
    markReminderWorkflowFailed.addRetry(STANDARD_RETRY);

    const reminderFail = new sfn.Fail(this, 'ReminderFail', {
      cause: 'Reminder workflow failed',
      error: 'WorkflowFailed',
    });
    markReminderWorkflowFailed.next(reminderFail);

    const checkEligibilityTask = buildTask(
      'CheckReminderEligibility',
      reminderFn.fn,
      markReminderWorkflowFailed,
    );
    const fetchAttendeesTask = buildTask(
      'FetchConfirmedAttendees',
      reminderFn.fn,
      markReminderWorkflowFailed,
    );
    const batchEnqueueTask = buildTask(
      'BatchEnqueueReminderNotifications',
      reminderFn.fn,
      markReminderWorkflowFailed,
    );
    const markReminderSentTask = buildTask(
      'MarkReminderSent',
      reminderFn.fn,
      markReminderWorkflowFailed,
    );

    const reminderSuccess = new sfn.Succeed(this, 'ReminderSuccess');
    markReminderSentTask.next(reminderSuccess);
    batchEnqueueTask.next(markReminderSentTask);
    fetchAttendeesTask.next(batchEnqueueTask);
    checkEligibilityTask.next(fetchAttendeesTask);

    const reminderMachine = new StepMachine(this, 'ReminderWorkflow', {
      machineName: 'reminder',
      definition: checkEligibilityTask,
    });
    this.reminderSfnArn = reminderMachine.stateMachine.stateMachineArn;

    // ─── 4. Post-Event Report Workflow ────────────────────────────────────────

    const reportFailFn = new LambdaFunction(this, 'ReportFailFn', {
      functionName: 'workflow-report-fail',
      codePath: '../lambda/src/workflows',
      handler: 'postEventReport.markWorkflowFailed',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(30),
    });
    auditLogTable.grant(reportFailFn.fn, 'dynamodb:PutItem');

    const markReportWorkflowFailed = new tasks.LambdaInvoke(
      this,
      'MarkReportWorkflowFailed',
      { lambdaFunction: reportFailFn.fn, outputPath: '$' },
    );
    markReportWorkflowFailed.addRetry(STANDARD_RETRY);

    const reportFail = new sfn.Fail(this, 'ReportFail', {
      cause: 'Post-event report workflow failed',
      error: 'WorkflowFailed',
    });
    markReportWorkflowFailed.next(reportFail);

    const aggregateMetricsTask = buildTask(
      'AggregateEventMetrics',
      postEventReportFn.fn,
      markReportWorkflowFailed,
    );
    const generatePDFTask = buildTask(
      'GeneratePDFReport',
      postEventReportFn.fn,
      markReportWorkflowFailed,
    );
    const generateCSVTask = buildTask(
      'GenerateCSVReport',
      postEventReportFn.fn,
      markReportWorkflowFailed,
    );
    const storeReportsTask = buildTask(
      'StoreReportsInS3',
      postEventReportFn.fn,
      markReportWorkflowFailed,
    );
    const updateAnalyticsTask = buildTask(
      'UpdateAnalyticsRecord',
      postEventReportFn.fn,
      markReportWorkflowFailed,
    );
    const notifyAdminsTask = buildTask(
      'NotifyAdminsReportReady',
      postEventReportFn.fn,
      markReportWorkflowFailed,
    );
    const reportAuditTask = buildTask(
      'ReportWriteAuditLog',
      postEventReportFn.fn,
      markReportWorkflowFailed,
    );

    const reportSuccess = new sfn.Succeed(this, 'ReportSuccess');
    reportAuditTask.next(reportSuccess);
    notifyAdminsTask.next(reportAuditTask);
    updateAnalyticsTask.next(notifyAdminsTask);
    storeReportsTask.next(updateAnalyticsTask);
    generateCSVTask.next(storeReportsTask);
    generatePDFTask.next(generateCSVTask);
    aggregateMetricsTask.next(generatePDFTask);

    const postEventReportMachine = new StepMachine(this, 'PostEventReportWorkflow', {
      machineName: 'post-event-report',
      definition: aggregateMetricsTask,
    });
    this.postEventReportSfnArn = postEventReportMachine.stateMachine.stateMachineArn;

    // ─── Update Scheduler Lambda env with real SFN ARNs ───────────────────────

    schedulerFnConstruct.fn.addEnvironment(
      'POST_EVENT_REPORT_SFN_ARN',
      postEventReportMachine.stateMachine.stateMachineArn,
    );
    schedulerFnConstruct.fn.addEnvironment(
      'REMINDER_SFN_ARN',
      reminderMachine.stateMachine.stateMachineArn,
    );

    // Allow Scheduler Lambda to start the SFN executions
    postEventReportMachine.stateMachine.grantStartExecution(schedulerFnConstruct.fn);
    reminderMachine.stateMachine.grantStartExecution(schedulerFnConstruct.fn);

    // ─── EventBridge: grant Scheduler Lambda as target (allow events:InvokeFunction) ───
    schedulerFnConstruct.fn.addPermission('EventBridgeInvoke', {
      principal: new iam.ServicePrincipal('events.amazonaws.com'),
      sourceArn: `arn:aws:events:${this.region}:${this.account}:rule/clois-*`,
    });

    // ─── Allow EventPublish Lambda to manage EventBridge rules ────────────────
    // (rules created point to the Scheduler Lambda as target)
    eventPublishFn.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:AddPermission', 'lambda:RemovePermission'],
        resources: [schedulerFnConstruct.fn.functionArn],
      }),
    );

    // ─── Allow SFN executions to invoke task Lambdas ──────────────────────────
    for (const machine of [
      eventPublishMachine.stateMachine,
      eventCancellationMachine.stateMachine,
      reminderMachine.stateMachine,
      postEventReportMachine.stateMachine,
    ]) {
      eventPublishFn.fn.grantInvoke(machine);
      eventCancellationFn.fn.grantInvoke(machine);
      reminderFn.fn.grantInvoke(machine);
      postEventReportFn.fn.grantInvoke(machine);
      publishFailFn.fn.grantInvoke(machine);
      cancellationFailFn.fn.grantInvoke(machine);
      reminderFailFn.fn.grantInvoke(machine);
      reportFailFn.fn.grantInvoke(machine);
    }

    // ─── Outputs ─────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'EventPublishSfnArn', {
      value: this.eventPublishSfnArn,
      exportName: 'CloisEventPublishSfnArn',
    });
    new cdk.CfnOutput(this, 'EventCancellationSfnArn', {
      value: this.eventCancellationSfnArn,
      exportName: 'CloisEventCancellationSfnArn',
    });
    new cdk.CfnOutput(this, 'ReminderSfnArn', {
      value: this.reminderSfnArn,
      exportName: 'CloisReminderSfnArn',
    });
    new cdk.CfnOutput(this, 'PostEventReportSfnArn', {
      value: this.postEventReportSfnArn,
      exportName: 'CloisPostEventReportSfnArn',
    });
    new cdk.CfnOutput(this, 'SchedulerFnArn', {
      value: this.schedulerFnArn,
      exportName: 'CloisSchedulerFnArn',
    });

    // Suppress unused import warning
    void events;
    void eventTargets;
  }
}
