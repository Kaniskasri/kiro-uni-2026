import {
  DynamoDBClient,
  UpdateItemCommand,
  PutItemCommand,
  QueryCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});

const MAIN_TABLE = process.env.MAIN_TABLE ?? 'clois-main';
const AUDIT_LOG_TABLE = process.env.AUDIT_LOG_TABLE ?? 'clois-audit-log';
const NOTIFICATION_QUEUE_URL = process.env.NOTIFICATION_QUEUE_URL ?? '';

export interface ReminderWorkflowInput {
  orgId: string;
  eventId: string;
  reminderType: '24h' | '1h';
  correlationId: string;
  actorId?: string;
}

export interface ReminderStepResult extends ReminderWorkflowInput {
  stepName: string;
  timestamp: string;
  skipped?: boolean;
  skipReason?: string;
  attendeeCount?: number;
  enqueuedCount?: number;
}

// ─── Step: CheckReminderEligibility ──────────────────────────────────────────

export async function checkReminderEligibility(
  input: ReminderWorkflowInput,
): Promise<ReminderStepResult> {
  const { orgId, eventId, reminderType, correlationId } = input;

  const result = await dynamo.send(
    new GetItemCommand({
      TableName: MAIN_TABLE,
      Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
    }),
  );

  if (!result.Item) {
    return {
      ...input,
      stepName: 'CheckReminderEligibility',
      timestamp: new Date().toISOString(),
      skipped: true,
      skipReason: 'Event not found',
    };
  }

  const event = unmarshall(result.Item);

  // Only send reminders for Published or Open events
  if (!['Published', 'Open'].includes(event['status'] as string)) {
    return {
      ...input,
      stepName: 'CheckReminderEligibility',
      timestamp: new Date().toISOString(),
      skipped: true,
      skipReason: `Event status is ${event['status']}, not eligible for reminder`,
    };
  }

  // Check if reminder time has already passed
  const startAt = new Date(event['startAt'] as string);
  const now = new Date();
  const offsetMs = reminderType === '24h' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const reminderTime = new Date(startAt.getTime() - offsetMs);

  if (now > reminderTime) {
    return {
      ...input,
      stepName: 'CheckReminderEligibility',
      timestamp: new Date().toISOString(),
      skipped: true,
      skipReason: `Reminder time (${reminderTime.toISOString()}) has already passed`,
    };
  }

  // Check if reminder already sent
  const reminderKey = `reminderSent_${reminderType}`;
  if (event[reminderKey] === true) {
    return {
      ...input,
      stepName: 'CheckReminderEligibility',
      timestamp: new Date().toISOString(),
      skipped: true,
      skipReason: `${reminderType} reminder already sent for this event`,
    };
  }

  void correlationId;

  return {
    ...input,
    stepName: 'CheckReminderEligibility',
    timestamp: new Date().toISOString(),
    skipped: false,
  };
}

// ─── Step: FetchConfirmedAttendees ────────────────────────────────────────────

export async function fetchConfirmedAttendees(
  input: ReminderStepResult,
): Promise<ReminderStepResult> {
  if (input.skipped) {
    return { ...input, stepName: 'FetchConfirmedAttendees', attendeeCount: 0 };
  }

  const { orgId, eventId } = input;

  const result = await dynamo.send(
    new QueryCommand({
      TableName: MAIN_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :orgId AND #status = :confirmed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':pk': `ORG#${orgId}#EVENT#${eventId}`,
        ':skPrefix': 'TICKET#',
        ':orgId': orgId,
        ':confirmed': 'Confirmed',
      }),
    }),
  );

  return {
    ...input,
    stepName: 'FetchConfirmedAttendees',
    timestamp: new Date().toISOString(),
    attendeeCount: result.Items?.length ?? 0,
  };
}

// ─── Step: BatchEnqueueReminderNotifications ──────────────────────────────────

export async function batchEnqueueReminderNotifications(
  input: ReminderStepResult,
): Promise<ReminderStepResult> {
  if (input.skipped || !NOTIFICATION_QUEUE_URL) {
    return {
      ...input,
      stepName: 'BatchEnqueueReminderNotifications',
      enqueuedCount: 0,
    };
  }

  const { orgId, eventId, reminderType, correlationId } = input;

  // Query confirmed tickets to get member IDs
  const result = await dynamo.send(
    new QueryCommand({
      TableName: MAIN_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :orgId AND #status = :confirmed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':pk': `ORG#${orgId}#EVENT#${eventId}`,
        ':skPrefix': 'TICKET#',
        ':orgId': orgId,
        ':confirmed': 'Confirmed',
      }),
    }),
  );

  const tickets = (result.Items ?? []).map((item) => unmarshall(item));
  let enqueuedCount = 0;

  for (const ticket of tickets) {
    if (!ticket['memberId']) continue;
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: NOTIFICATION_QUEUE_URL,
        MessageBody: JSON.stringify({
          type: 'EVENT_REMINDER',
          orgId,
          eventId,
          recipientMemberId: ticket['memberId'],
          ticketId: ticket['ticketId'],
          reminderType,
          correlationId,
        }),
      }),
    );
    enqueuedCount++;
  }

  return {
    ...input,
    stepName: 'BatchEnqueueReminderNotifications',
    timestamp: new Date().toISOString(),
    enqueuedCount,
  };
}

// ─── Step: MarkReminderSent ───────────────────────────────────────────────────

export async function markReminderSent(
  input: ReminderStepResult,
): Promise<ReminderStepResult> {
  if (input.skipped) {
    return { ...input, stepName: 'MarkReminderSent' };
  }

  const { orgId, eventId, reminderType, correlationId } = input;
  const ts = new Date().toISOString();

  const reminderKey = `reminderSent_${reminderType}`;

  await dynamo.send(
    new UpdateItemCommand({
      TableName: MAIN_TABLE,
      Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
      UpdateExpression: `SET ${reminderKey} = :true, updatedAt = :ts`,
      ConditionExpression: 'tenantId = :orgId',
      ExpressionAttributeValues: marshall({
        ':true': true,
        ':ts': ts,
        ':orgId': orgId,
      }),
    }),
  );

  // Write audit log entry
  await dynamo.send(
    new PutItemCommand({
      TableName: AUDIT_LOG_TABLE,
      Item: marshall({
        PK: `ORG#${orgId}`,
        SK: `AUDIT#${ts}#${correlationId}`,
        type: 'AUDIT_LOG',
        tenantId: orgId,
        timestamp: ts,
        actor: 'system',
        targetType: 'EVENT',
        targetId: eventId,
        operation: `event.reminder_sent_${reminderType}`,
        sourceIp: 'system',
        outcome: 'success',
        correlationId,
        enqueuedCount: input.enqueuedCount ?? 0,
      }),
    }),
  );

  return { ...input, stepName: 'MarkReminderSent', timestamp: ts };
}

// ─── Step: MarkWorkflowFailed (catch-all) ────────────────────────────────────

export async function markWorkflowFailed(
  input: ReminderWorkflowInput & { error?: string },
): Promise<void> {
  const { orgId, eventId, correlationId, error } = input;
  const ts = new Date().toISOString();

  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: AUDIT_LOG_TABLE,
        Item: marshall({
          PK: `ORG#${orgId}`,
          SK: `AUDIT#${ts}#${correlationId}`,
          type: 'AUDIT_LOG',
          tenantId: orgId,
          timestamp: ts,
          actor: 'system',
          targetType: 'EVENT',
          targetId: eventId,
          operation: 'event.reminder_workflow_failed',
          sourceIp: 'system',
          outcome: 'failure',
          correlationId,
          errorDetail: (error ?? 'Unknown error').slice(0, 500),
        }),
      }),
    );
  } catch {
    process.stderr.write(
      JSON.stringify({
        level: 'ERROR',
        message: 'Failed to write reminder workflow-failed audit log',
        orgId,
        eventId,
        correlationId,
      }) + '\n',
    );
  }
}
