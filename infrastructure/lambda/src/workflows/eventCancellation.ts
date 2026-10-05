import {
  DynamoDBClient,
  UpdateItemCommand,
  PutItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, DeleteRuleCommand, RemoveTargetsCommand } from '@aws-sdk/client-eventbridge';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({});
const eventBridge = new EventBridgeClient({});
const sqs = new SQSClient({});

const MAIN_TABLE = process.env.MAIN_TABLE ?? 'clois-main';
const AUDIT_LOG_TABLE = process.env.AUDIT_LOG_TABLE ?? 'clois-audit-log';
const NOTIFICATION_QUEUE_URL = process.env.NOTIFICATION_QUEUE_URL ?? '';

export interface CancellationWorkflowInput {
  orgId: string;
  eventId: string;
  actorId: string;
  sourceIp?: string;
  correlationId: string;
  cancellationReason?: string;
}

export interface CancellationStepResult extends CancellationWorkflowInput {
  stepName: string;
  timestamp: string;
  voidedTicketCount?: number;
}

// ─── Step: SetCancelledStatus ─────────────────────────────────────────────────

export async function setCancelledStatus(
  input: CancellationWorkflowInput,
): Promise<CancellationStepResult> {
  const { orgId, eventId, correlationId } = input;

  await dynamo.send(
    new UpdateItemCommand({
      TableName: MAIN_TABLE,
      Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
      UpdateExpression: 'SET #status = :cancelled, updatedAt = :ts, cancellationReason = :reason',
      ConditionExpression:
        'tenantId = :orgId AND #status IN (:draft, :published, :open, :inProgress)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':cancelled': 'Cancelled',
        ':draft': 'Draft',
        ':published': 'Published',
        ':open': 'Open',
        ':inProgress': 'In_Progress',
        ':orgId': orgId,
        ':ts': new Date().toISOString(),
        ':reason': input.cancellationReason ?? 'Cancelled by organizer',
      }),
    }),
  );

  return {
    ...input,
    stepName: 'SetCancelledStatus',
    timestamp: new Date().toISOString(),
  };
}

// ─── Step: VoidAllTickets ─────────────────────────────────────────────────────

export async function voidAllTickets(
  input: CancellationStepResult,
): Promise<CancellationStepResult> {
  const { orgId, eventId } = input;

  // Query all active tickets for this event
  const queryResult = await dynamo.send(
    new QueryCommand({
      TableName: MAIN_TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :orgId AND #status IN (:confirmed, :waitlisted)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':pk': `ORG#${orgId}#EVENT#${eventId}`,
        ':skPrefix': 'TICKET#',
        ':orgId': orgId,
        ':confirmed': 'Confirmed',
        ':waitlisted': 'Waitlisted',
      }),
    }),
  );

  const tickets = (queryResult.Items ?? []).map((item) => unmarshall(item));
  let voidedCount = 0;

  for (const ticket of tickets) {
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: MAIN_TABLE,
          Key: marshall({
            PK: `ORG#${orgId}#EVENT#${eventId}`,
            SK: `TICKET#${ticket['ticketId']}`,
          }),
          UpdateExpression: 'SET #status = :voided, updatedAt = :ts',
          ConditionExpression: 'tenantId = :orgId',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({
            ':voided': 'Voided',
            ':orgId': orgId,
            ':ts': new Date().toISOString(),
          }),
        }),
      );
      voidedCount++;
    } catch {
      // Continue voiding remaining tickets even if one fails
      process.stderr.write(
        JSON.stringify({
          level: 'WARN',
          message: 'Failed to void ticket',
          ticketId: ticket['ticketId'],
          orgId,
          eventId,
        }) + '\n',
      );
    }
  }

  return {
    ...input,
    stepName: 'VoidAllTickets',
    timestamp: new Date().toISOString(),
    voidedTicketCount: voidedCount,
  };
}

// ─── Step: EnqueueAttendeeNotifications ──────────────────────────────────────

export async function enqueueAttendeeNotifications(
  input: CancellationStepResult,
): Promise<CancellationStepResult> {
  const { orgId, eventId, correlationId, voidedTicketCount } = input;

  if (NOTIFICATION_QUEUE_URL) {
    // Query confirmed ticket holders to notify them
    const queryResult = await dynamo.send(
      new QueryCommand({
        TableName: MAIN_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression: 'tenantId = :orgId',
        ExpressionAttributeValues: marshall({
          ':pk': `ORG#${orgId}#EVENT#${eventId}`,
          ':skPrefix': 'TICKET#',
          ':orgId': orgId,
        }),
      }),
    );

    const tickets = (queryResult.Items ?? []).map((item) => unmarshall(item));

    for (const ticket of tickets) {
      if (!ticket['memberId']) continue;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: NOTIFICATION_QUEUE_URL,
          MessageBody: JSON.stringify({
            type: 'EVENT_CANCELLED',
            orgId,
            eventId,
            recipientMemberId: ticket['memberId'],
            ticketId: ticket['ticketId'],
            cancellationReason: input.cancellationReason,
            correlationId,
          }),
        }),
      );
    }
  }

  return {
    ...input,
    stepName: 'EnqueueAttendeeNotifications',
    timestamp: new Date().toISOString(),
    voidedTicketCount,
  };
}

// ─── Step: DeleteEventBridgeRules ─────────────────────────────────────────────

export async function deleteEventBridgeRules(
  input: CancellationStepResult,
): Promise<CancellationStepResult> {
  const { orgId, eventId } = input;

  const ruleNames = [
    `clois-event-start-${orgId}-${eventId}`,
    `clois-event-end-${orgId}-${eventId}`,
    `clois-reminder-24h-${orgId}-${eventId}`,
    `clois-reminder-1h-${orgId}-${eventId}`,
  ];

  for (const ruleName of ruleNames) {
    try {
      // Must remove targets before deleting rule
      await eventBridge.send(
        new RemoveTargetsCommand({
          Rule: ruleName,
          Ids: [`${ruleName}-target-${eventId}`],
        }),
      );
      await eventBridge.send(new DeleteRuleCommand({ Name: ruleName }));
    } catch {
      // Rule may not exist if publish workflow did not complete — ignore
      process.stderr.write(
        JSON.stringify({
          level: 'INFO',
          message: `EventBridge rule not found or already deleted: ${ruleName}`,
        }) + '\n',
      );
    }
  }

  return { ...input, stepName: 'DeleteEventBridgeRules', timestamp: new Date().toISOString() };
}

// ─── Step: WriteAuditLog ──────────────────────────────────────────────────────

export async function writeAuditLog(
  input: CancellationStepResult,
): Promise<CancellationStepResult> {
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
        operation: 'event.cancelled',
        sourceIp: sourceIp ?? 'system',
        outcome: 'success',
        correlationId,
        voidedTicketCount: input.voidedTicketCount ?? 0,
      }),
    }),
  );

  return { ...input, stepName: 'WriteAuditLog', timestamp: ts };
}

// ─── Step: MarkWorkflowFailed (catch-all) ────────────────────────────────────

export async function markWorkflowFailed(
  input: CancellationWorkflowInput & { error?: string },
): Promise<void> {
  const { orgId, eventId, actorId, sourceIp, correlationId, error } = input;
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
          actor: actorId ?? 'system',
          targetType: 'EVENT',
          targetId: eventId,
          operation: 'event.cancellation_workflow_failed',
          sourceIp: sourceIp ?? 'system',
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
        message: 'Failed to write workflow-failed audit log entry',
        orgId,
        eventId,
        correlationId,
      }) + '\n',
    );
  }
}
