import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ConditionalCheckFailedException,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { TicketDynamoItem } from '../tickets/types';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

// ─── Check-In repository ──────────────────────────────────────────────────────

/**
 * Looks up a ticket by its ticketCode via GSI1.
 * GSI1PK = TICKETCODE#{ticketCode}
 * tenantId condition enforces multi-tenant isolation.
 */
export async function findTicketByCode(
  ticketCode: string,
  tenantId: string,
): Promise<TicketDynamoItem | null> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: marshall({
        ':gsi1pk': `TICKETCODE#${ticketCode}`,
        ':tenantId': tenantId,
      }),
      Limit: 1,
    }),
  );

  if (!result.Items || result.Items.length === 0) return null;
  return unmarshall(result.Items[0]) as TicketDynamoItem;
}

/**
 * Marks a ticket as CheckedIn using a conditional update.
 * Condition: ticket must currently be Confirmed (not already CheckedIn or Cancelled).
 * Includes tenantId condition to prevent cross-org writes.
 *
 * Returns the updated ticket or null if the condition failed
 * (ticket was already CheckedIn — caller handles idempotency).
 */
export async function markCheckedIn(
  orgId: string,
  eventId: string,
  ticketId: string,
  tenantId: string,
  checkedInAt: string,
  checkedInBy: string,
): Promise<{ updated: true; ticket: TicketDynamoItem } | { updated: false }> {
  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({
          PK: `ORG#${orgId}#EVENT#${eventId}#TICKET#${ticketId}`,
          SK: 'METADATA',
        }),
        UpdateExpression:
          'SET #status = :checkedIn, checkedInAt = :checkedInAt, checkedInBy = :checkedInBy, updatedAt = :updatedAt',
        ConditionExpression:
          'attribute_exists(PK) AND tenantId = :tenantId AND #status = :confirmed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':checkedIn': 'CheckedIn',
          ':confirmed': 'Confirmed',
          ':tenantId': tenantId,
          ':checkedInAt': checkedInAt,
          ':checkedInBy': checkedInBy,
          ':updatedAt': checkedInAt,
        }),
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      return { updated: false };
    }

    return { updated: true, ticket: unmarshall(result.Attributes) as TicketDynamoItem };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Either already CheckedIn or access denied — caller resolves
      return { updated: false };
    }
    throw err;
  }
}

/**
 * Fetches a ticket by PK/SK directly.
 * Used to retrieve the current state when markCheckedIn condition fails.
 * tenantId condition enforces multi-tenant isolation.
 */
export async function getTicketById(
  orgId: string,
  eventId: string,
  ticketId: string,
  tenantId: string,
): Promise<TicketDynamoItem | null> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({
        PK: `ORG#${orgId}#EVENT#${eventId}#TICKET#${ticketId}`,
        SK: 'METADATA',
      }),
    }),
  );

  if (!result.Item) return null;
  const item = unmarshall(result.Item) as TicketDynamoItem;
  if (item.tenantId !== tenantId) return null;
  return item;
}

/**
 * Counts CheckedIn tickets for an event.
 * Used for capacity percentage calculation and WebSocket broadcast.
 */
export async function countCheckedInTickets(
  orgId: string,
  eventId: string,
  tenantId: string,
): Promise<number> {
  let count = 0;
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK begins_with :pkPrefix',
        FilterExpression: 'tenantId = :tenantId AND SK = :sk AND #status = :checkedIn',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':pkPrefix': `ORG#${orgId}#EVENT#${eventId}#TICKET#`,
          ':tenantId': tenantId,
          ':sk': 'METADATA',
          ':checkedIn': 'CheckedIn',
        }),
        Select: 'COUNT',
        ExclusiveStartKey: lastKey,
      }),
    );

    count += result.Count ?? 0;
    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);

  return count;
}
