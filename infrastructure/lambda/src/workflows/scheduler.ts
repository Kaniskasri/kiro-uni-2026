import { DynamoDBClient, UpdateItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const sfn = new SFNClient({});

const MAIN_TABLE = process.env.MAIN_TABLE ?? 'clois-main';
const AUDIT_LOG_TABLE = process.env.AUDIT_LOG_TABLE ?? 'clois-audit-log';
const POST_EVENT_REPORT_SFN_ARN = process.env.POST_EVENT_REPORT_SFN_ARN ?? '';
const REMINDER_SFN_ARN = process.env.REMINDER_SFN_ARN ?? '';

export type SchedulerAction =
  | 'TRANSITION_TO_IN_PROGRESS'
  | 'TRANSITION_TO_COMPLETED'
  | 'SEND_REMINDER';

export interface SchedulerInput {
  action: SchedulerAction;
  orgId: string;
  eventId: string;
  correlationId: string;
  reminderType?: '24h' | '1h';
}

/**
 * SchedulerFn
 *
 * Handles EventBridge scheduled rules for:
 *  - T-start: transition event to In_Progress
 *  - T-end:   transition event to Completed, trigger Post-Event Report SFN
 *  - Reminder: trigger Reminder SFN for pre-event notifications
 */
export async function handler(event: SchedulerInput): Promise<{ success: boolean }> {
  const { action, orgId, eventId, correlationId, reminderType } = event;

  process.stdout.write(
    JSON.stringify({ level: 'INFO', message: 'Scheduler action triggered', action, orgId, eventId, correlationId }) + '\n',
  );

  switch (action) {
    case 'TRANSITION_TO_IN_PROGRESS':
      await transitionToInProgress(orgId, eventId, correlationId);
      break;
    case 'TRANSITION_TO_COMPLETED':
      await transitionToCompleted(orgId, eventId, correlationId);
      break;
    case 'SEND_REMINDER':
      await triggerReminderWorkflow(orgId, eventId, reminderType ?? '24h', correlationId);
      break;
    default: {
      const exhaustiveCheck: never = action;
      process.stderr.write(
        JSON.stringify({ level: 'WARN', message: 'Unknown scheduler action', action: exhaustiveCheck }) + '\n',
      );
    }
  }

  return { success: true };
}

// ─── Transition: Draft/Published/Open → In_Progress ──────────────────────────

async function transitionToInProgress(
  orgId: string,
  eventId: string,
  correlationId: string,
): Promise<void> {
  const ts = new Date().toISOString();

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: MAIN_TABLE,
        Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
        UpdateExpression: 'SET #status = :inProgress, updatedAt = :ts',
        // Published → In_Progress transition per the state machine
        ConditionExpression: '#status = :published AND tenantId = :orgId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':inProgress': 'In_Progress',
          ':published': 'Published',
          ':orgId': orgId,
          ':ts': ts,
        }),
      }),
    );
  } catch {
    // Try Open → In_Progress if Published transition fails
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: MAIN_TABLE,
          Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
          UpdateExpression: 'SET #status = :inProgress, updatedAt = :ts',
          ConditionExpression: '#status = :open AND tenantId = :orgId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({
            ':inProgress': 'In_Progress',
            ':open': 'Open',
            ':orgId': orgId,
            ':ts': ts,
          }),
        }),
      );
    } catch {
      process.stderr.write(
        JSON.stringify({
          level: 'WARN',
          message: 'Could not transition event to In_Progress — may already be in that state or cancelled',
          orgId,
          eventId,
          correlationId,
        }) + '\n',
      );
      return;
    }
  }

  await writeAuditLog(orgId, eventId, 'system', correlationId, 'event.transitioned_to_in_progress');
}

// ─── Transition: In_Progress → Completed ─────────────────────────────────────

async function transitionToCompleted(
  orgId: string,
  eventId: string,
  correlationId: string,
): Promise<void> {
  const ts = new Date().toISOString();

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: MAIN_TABLE,
        Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
        UpdateExpression: 'SET #status = :completed, updatedAt = :ts',
        ConditionExpression: '#status = :inProgress AND tenantId = :orgId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':completed': 'Completed',
          ':inProgress': 'In_Progress',
          ':orgId': orgId,
          ':ts': ts,
        }),
      }),
    );
  } catch {
    process.stderr.write(
      JSON.stringify({
        level: 'WARN',
        message: 'Could not transition event to Completed — may already be completed or cancelled',
        orgId,
        eventId,
        correlationId,
      }) + '\n',
    );
    return;
  }

  await writeAuditLog(orgId, eventId, 'system', correlationId, 'event.transitioned_to_completed');

  // Trigger Post-Event Report Step Functions workflow
  if (POST_EVENT_REPORT_SFN_ARN) {
    try {
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: POST_EVENT_REPORT_SFN_ARN,
          name: `post-event-report-${eventId}-${Date.now()}`,
          input: JSON.stringify({
            orgId,
            eventId,
            actorId: 'system',
            correlationId,
          }),
        }),
      );
      process.stdout.write(
        JSON.stringify({ level: 'INFO', message: 'Post-event report SFN triggered', orgId, eventId }) + '\n',
      );
    } catch (err) {
      const error = err as Error;
      process.stderr.write(
        JSON.stringify({
          level: 'ERROR',
          message: 'Failed to trigger post-event report SFN',
          orgId,
          eventId,
          error: error.message,
        }) + '\n',
      );
    }
  }
}

// ─── Trigger Reminder Workflow ────────────────────────────────────────────────

async function triggerReminderWorkflow(
  orgId: string,
  eventId: string,
  reminderType: '24h' | '1h',
  correlationId: string,
): Promise<void> {
  if (!REMINDER_SFN_ARN) {
    process.stderr.write(
      JSON.stringify({ level: 'WARN', message: 'REMINDER_SFN_ARN not set, skipping reminder' }) + '\n',
    );
    return;
  }

  try {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: REMINDER_SFN_ARN,
        name: `reminder-${reminderType}-${eventId}-${Date.now()}`,
        input: JSON.stringify({
          orgId,
          eventId,
          reminderType,
          correlationId,
          actorId: 'system',
        }),
      }),
    );
    process.stdout.write(
      JSON.stringify({ level: 'INFO', message: `Reminder SFN triggered`, reminderType, orgId, eventId }) + '\n',
    );
  } catch (err) {
    const error = err as Error;
    process.stderr.write(
      JSON.stringify({
        level: 'ERROR',
        message: 'Failed to trigger reminder SFN',
        orgId,
        eventId,
        reminderType,
        error: error.message,
      }) + '\n',
    );
  }
}

// ─── Audit Log Helper ─────────────────────────────────────────────────────────

async function writeAuditLog(
  orgId: string,
  eventId: string,
  actorId: string,
  correlationId: string,
  operation: string,
): Promise<void> {
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
          actor: actorId,
          targetType: 'EVENT',
          targetId: eventId,
          operation,
          sourceIp: 'system',
          outcome: 'success',
          correlationId,
        }),
      }),
    );
  } catch (err) {
    const error = err as Error;
    process.stderr.write(
      JSON.stringify({
        level: 'ERROR',
        message: 'Failed to write audit log',
        operation,
        error: error.message,
      }) + '\n',
    );
  }
}
