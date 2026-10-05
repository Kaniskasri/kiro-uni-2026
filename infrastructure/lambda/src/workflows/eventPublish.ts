import { DynamoDBClient, UpdateItemCommand, PutItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const eventBridge = new EventBridgeClient({});
const sqs = new SQSClient({});

const MAIN_TABLE = process.env.MAIN_TABLE ?? 'clois-main';
const AUDIT_LOG_TABLE = process.env.AUDIT_LOG_TABLE ?? 'clois-audit-log';
const NOTIFICATION_QUEUE_URL = process.env.NOTIFICATION_QUEUE_URL ?? '';
const SCHEDULER_FUNCTION_ARN = process.env.SCHEDULER_FUNCTION_ARN ?? '';

export interface PublishWorkflowInput {
  orgId: string;
  eventId: string;
  actorId: string;
  sourceIp?: string;
  correlationId: string;
}

export interface WorkflowStepResult {
  orgId: string;
  eventId: string;
  actorId: string;
  sourceIp?: string;
  correlationId: string;
  stepName: string;
  timestamp: string;
  // Optional fields passed through workflow
  eventTitle?: string;
  eventStartAt?: string;
  eventEndAt?: string;
  capacity?: number;
}

// ─── Step: ValidateEvent ──────────────────────────────────────────────────────

export async function validateEvent(input: PublishWorkflowInput): Promise<WorkflowStepResult> {
  const { orgId, eventId, correlationId } = input;

  const result = await dynamo.send(
    new GetItemCommand({
      TableName: MAIN_TABLE,
      Key: marshall({
        PK: `ORG#${orgId}#EVENT#${eventId}`,
        SK: `METADATA`,
      }),
    }),
  );

  if (!result.Item) {
    throw new Error(
      JSON.stringify({
        errorCode: 'event.not_found',
        message: `Event ${eventId} not found in org ${orgId}`,
        correlationId,
      }),
    );
  }

  const item = unmarshall(result.Item);

  // Enforce tenant isolation — tenantId must match orgId from JWT
  if (item['tenantId'] !== orgId) {
    throw new Error(
      JSON.stringify({
        errorCode: 'event.not_found',
        message: `Event ${eventId} not found in org ${orgId}`,
        correlationId,
      }),
    );
  }

  if (item['status'] !== 'Draft') {
    throw new Error(
      JSON.stringify({
        errorCode: 'event.invalid_state_for_publish',
        message: `Event must be in Draft status to publish. Current status: ${item['status']}`,
        correlationId,
      }),
    );
  }

  if (!item['title'] || !item['startAt'] || !item['endAt'] || !item['capacity']) {
    throw new Error(
      JSON.stringify({
        errorCode: 'event.incomplete_for_publish',
        message: 'Event must have title, startAt, endAt, and capacity to publish.',
        correlationId,
      }),
    );
  }

  return {
    ...input,
    stepName: 'ValidateEvent',
    timestamp: new Date().toISOString(),
    eventTitle: item['title'] as string,
    eventStartAt: item['startAt'] as string,
    eventEndAt: item['endAt'] as string,
    capacity: item['capacity'] as number,
  };
}

// ─── Step: ScheduleEventBridgeRules ──────────────────────────────────────────

export async function scheduleEventBridgeRules(
  input: WorkflowStepResult,
): Promise<WorkflowStepResult> {
  const { orgId, eventId, eventStartAt, eventEndAt, correlationId } = input;

  if (!eventStartAt || !eventEndAt) {
    throw new Error(
      JSON.stringify({
        errorCode: 'event.missing_dates',
        message: 'Event start and end times are required for scheduling',
        correlationId,
      }),
    );
  }

  const startDate = new Date(eventStartAt);
  const endDate = new Date(eventEndAt);

  // T-start rule: transition event to In_Progress
  const startRuleName = `clois-event-start-${orgId}-${eventId}`;
  const tStartCron = dateToCron(startDate);

  await eventBridge.send(
    new PutRuleCommand({
      Name: startRuleName,
      ScheduleExpression: `cron(${tStartCron})`,
      State: 'ENABLED',
      Description: `CLOIS T-start rule for event ${eventId} in org ${orgId}`,
    }),
  );

  await eventBridge.send(
    new PutTargetsCommand({
      Rule: startRuleName,
      Targets: [
        {
          Id: `clois-event-start-target-${eventId}`,
          Arn: SCHEDULER_FUNCTION_ARN,
          Input: JSON.stringify({
            action: 'TRANSITION_TO_IN_PROGRESS',
            orgId,
            eventId,
            correlationId,
          }),
        },
      ],
    }),
  );

  // T-end rule: transition event to Completed and trigger post-event report SFN
  const endRuleName = `clois-event-end-${orgId}-${eventId}`;
  const tEndCron = dateToCron(endDate);

  await eventBridge.send(
    new PutRuleCommand({
      Name: endRuleName,
      ScheduleExpression: `cron(${tEndCron})`,
      State: 'ENABLED',
      Description: `CLOIS T-end rule for event ${eventId} in org ${orgId}`,
    }),
  );

  await eventBridge.send(
    new PutTargetsCommand({
      Rule: endRuleName,
      Targets: [
        {
          Id: `clois-event-end-target-${eventId}`,
          Arn: SCHEDULER_FUNCTION_ARN,
          Input: JSON.stringify({
            action: 'TRANSITION_TO_COMPLETED',
            orgId,
            eventId,
            correlationId,
          }),
        },
      ],
    }),
  );

  return { ...input, stepName: 'ScheduleEventBridgeRules', timestamp: new Date().toISOString() };
}

// ─── Step: SetPublishedStatus ─────────────────────────────────────────────────

export async function setPublishedStatus(input: WorkflowStepResult): Promise<WorkflowStepResult> {
  const { orgId, eventId, correlationId } = input;

  await dynamo.send(
    new UpdateItemCommand({
      TableName: MAIN_TABLE,
      Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
      UpdateExpression: 'SET #status = :published, updatedAt = :ts',
      ConditionExpression: '#status = :draft AND tenantId = :orgId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':published': 'Published',
        ':draft': 'Draft',
        ':orgId': orgId,
        ':ts': new Date().toISOString(),
      }),
    }),
  );

  return { ...input, stepName: 'SetPublishedStatus', timestamp: new Date().toISOString() };
}

// ─── Step: ScheduleReminders ──────────────────────────────────────────────────

export async function scheduleReminders(input: WorkflowStepResult): Promise<WorkflowStepResult> {
  const { orgId, eventId, eventStartAt, correlationId } = input;

  if (!eventStartAt) {
    return { ...input, stepName: 'ScheduleReminders', timestamp: new Date().toISOString() };
  }

  const startDate = new Date(eventStartAt);
  const reminder24h = new Date(startDate.getTime() - 24 * 60 * 60 * 1000);
  const reminder1h = new Date(startDate.getTime() - 60 * 60 * 1000);
  const now = new Date();

  // Schedule 24h reminder if it hasn't passed yet
  if (reminder24h > now) {
    const ruleName24h = `clois-reminder-24h-${orgId}-${eventId}`;
    await eventBridge.send(
      new PutRuleCommand({
        Name: ruleName24h,
        ScheduleExpression: `cron(${dateToCron(reminder24h)})`,
        State: 'ENABLED',
        Description: `CLOIS 24h reminder rule for event ${eventId}`,
      }),
    );
    await eventBridge.send(
      new PutTargetsCommand({
        Rule: ruleName24h,
        Targets: [
          {
            Id: `clois-reminder-24h-target-${eventId}`,
            Arn: SCHEDULER_FUNCTION_ARN,
            Input: JSON.stringify({
              action: 'SEND_REMINDER',
              orgId,
              eventId,
              reminderType: '24h',
              correlationId,
            }),
          },
        ],
      }),
    );
  }

  // Schedule 1h reminder if it hasn't passed yet
  if (reminder1h > now) {
    const ruleName1h = `clois-reminder-1h-${orgId}-${eventId}`;
    await eventBridge.send(
      new PutRuleCommand({
        Name: ruleName1h,
        ScheduleExpression: `cron(${dateToCron(reminder1h)})`,
        State: 'ENABLED',
        Description: `CLOIS 1h reminder rule for event ${eventId}`,
      }),
    );
    await eventBridge.send(
      new PutTargetsCommand({
        Rule: ruleName1h,
        Targets: [
          {
            Id: `clois-reminder-1h-target-${eventId}`,
            Arn: SCHEDULER_FUNCTION_ARN,
            Input: JSON.stringify({
              action: 'SEND_REMINDER',
              orgId,
              eventId,
              reminderType: '1h',
              correlationId,
            }),
          },
        ],
      }),
    );
  }

  return { ...input, stepName: 'ScheduleReminders', timestamp: new Date().toISOString() };
}

// ─── Step: EmitPublishedEvent ─────────────────────────────────────────────────

export async function emitPublishedEvent(input: WorkflowStepResult): Promise<WorkflowStepResult> {
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: 'default',
          Source: 'clois/events',
          DetailType: 'com.clois.v1.event.published',
          Detail: JSON.stringify({
            specversion: '1.0',
            type: 'com.clois.v1.event.published',
            source: 'clois/events',
            id: input.correlationId,
            time: new Date().toISOString(),
            datacontenttype: 'application/json',
            data: {
              orgId: input.orgId,
              eventId: input.eventId,
              eventTitle: input.eventTitle,
            },
          }),
        },
      ],
    }),
  );

  return { ...input, stepName: 'EmitPublishedEvent', timestamp: new Date().toISOString() };
}

// ─── Step: WriteAuditLog ──────────────────────────────────────────────────────

export async function writeAuditLog(input: WorkflowStepResult): Promise<WorkflowStepResult> {
  const { orgId, eventId, actorId, sourceIp, correlationId } = input;
  const ts = new Date().toISOString();

  await dynamo.send(
    new PutItemCommand({
      TableName: AUDIT_LOG_TABLE,
      Item: marshall({
        PK: `ORG#${orgId}`,
        SK: `AUDIT#${ts}#${correlationId}`,
        type: 'AUDIT_LOG',
        tenantId: orgId,
        timestamp: ts,
        actor: actorId,
        targetType: 'EVENT',
        targetId: eventId,
        operation: 'event.published',
        sourceIp: sourceIp ?? 'system',
        outcome: 'success',
        correlationId,
      }),
    }),
  );

  return { ...input, stepName: 'WriteAuditLog', timestamp: ts };
}

// ─── Step: RevertToDraft ──────────────────────────────────────────────────────

export async function revertToDraft(input: WorkflowStepResult): Promise<WorkflowStepResult> {
  const { orgId, eventId } = input;

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: MAIN_TABLE,
        Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
        UpdateExpression: 'SET #status = :draft, updatedAt = :ts',
        ConditionExpression: 'tenantId = :orgId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':draft': 'Draft',
          ':orgId': orgId,
          ':ts': new Date().toISOString(),
        }),
      }),
    );
  } catch {
    // Best-effort revert — log and continue
    process.stderr.write(
      JSON.stringify({ level: 'ERROR', message: 'Failed to revert event to Draft', orgId, eventId }) + '\n',
    );
  }

  return { ...input, stepName: 'RevertToDraft', timestamp: new Date().toISOString() };
}

// ─── Step: NotifyOrganizer ────────────────────────────────────────────────────

export async function notifyOrganizer(input: WorkflowStepResult): Promise<WorkflowStepResult> {
  const { orgId, eventId, actorId, correlationId } = input;

  if (NOTIFICATION_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: NOTIFICATION_QUEUE_URL,
        MessageBody: JSON.stringify({
          type: 'EVENT_PUBLISH_FAILED',
          orgId,
          eventId,
          recipientMemberId: actorId,
          message: `Publishing event ${eventId} failed and was reverted to Draft.`,
          correlationId,
        }),
      }),
    );
  }

  return { ...input, stepName: 'NotifyOrganizer', timestamp: new Date().toISOString() };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converts a Date to a cron expression for EventBridge (UTC). */
function dateToCron(date: Date): string {
  const m = date.getUTCMinutes();
  const h = date.getUTCHours();
  const dom = date.getUTCDate();
  const mon = date.getUTCMonth() + 1;
  const y = date.getUTCFullYear();
  // EventBridge cron: cron(Minutes Hours Day Month ? Year)
  return `${m} ${h} ${dom} ${mon} ? ${y}`;
}

void sqs;
