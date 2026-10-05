import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  ConditionalCheckFailedException,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { TicketDynamoItem, TicketStatus } from './types';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

// ─── Helper ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Ticket queries ───────────────────────────────────────────────────────────

/**
 * Creates a new Ticket item.
 * PK = ORG#{orgId}#EVENT#{eventId}#TICKET#{ticketId}, SK = METADATA
 * GSI1PK = TICKETCODE#{ticketCode}, GSI1SK = TICKET#{ticketId}
 * GSI3PK = MEMBER#{memberId}#EVENT#{eventId} or GUEST#{email}#EVENT#{eventId}
 */
export async function createTicket(
  item: Omit<TicketDynamoItem, 'createdAt' | 'updatedAt'>,
): Promise<TicketDynamoItem> {
  const now = nowIso();
  const fullItem: TicketDynamoItem = { ...item, createdAt: now, updatedAt: now };

  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall(fullItem, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return fullItem;
}

/**
 * Fetches a single Ticket by orgId + eventId + ticketId.
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

  // tenantId isolation check
  if (item.tenantId !== tenantId) return null;

  return item;
}

/**
 * Checks for duplicate RSVP by querying GSI3 with MEMBER#{memberId}#EVENT#{eventId}.
 * Returns the existing active ticket if found.
 */
export async function findTicketByMemberAndEvent(
  memberId: string,
  eventId: string,
  orgId: string,
): Promise<TicketDynamoItem | null> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :gsi3pk',
      FilterExpression: 'tenantId = :tenantId AND #status <> :cancelled',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':gsi3pk': `MEMBER#${memberId}#EVENT#${eventId}`,
        ':tenantId': orgId,
        ':cancelled': 'Cancelled',
      }),
      Limit: 1,
    }),
  );

  if (!result.Items || result.Items.length === 0) return null;
  return unmarshall(result.Items[0]) as TicketDynamoItem;
}

/**
 * Checks for duplicate guest RSVP by querying GSI3 with GUEST#{email}#EVENT#{eventId}.
 * Returns the existing active ticket if found.
 */
export async function findTicketByGuestEmailAndEvent(
  guestEmail: string,
  eventId: string,
  orgId: string,
): Promise<TicketDynamoItem | null> {
  const normalizedEmail = guestEmail.toLowerCase().trim();
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :gsi3pk',
      FilterExpression: 'tenantId = :tenantId AND #status <> :cancelled',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':gsi3pk': `GUEST#${normalizedEmail}#EVENT#${eventId}`,
        ':tenantId': orgId,
        ':cancelled': 'Cancelled',
      }),
      Limit: 1,
    }),
  );

  if (!result.Items || result.Items.length === 0) return null;
  return unmarshall(result.Items[0]) as TicketDynamoItem;
}

/**
 * Lists all tickets for an event, paginated.
 * Uses PK query with begins_with ORG#{orgId}#EVENT#{eventId}#TICKET#
 */
export async function listTicketsByEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
  limit: number,
  nextToken?: string,
): Promise<{ tickets: TicketDynamoItem[]; nextToken?: string }> {
  const exclusiveStartKey = nextToken
    ? (JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8')) as Record<string, AttributeValue>)
    : undefined;

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK begins_with :pkPrefix',
      FilterExpression: 'tenantId = :tenantId AND SK = :sk',
      ExpressionAttributeValues: marshall({
        ':pkPrefix': `ORG#${orgId}#EVENT#${eventId}#TICKET#`,
        ':tenantId': tenantId,
        ':sk': 'METADATA',
      }),
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const tickets = (result.Items ?? []).map((i) => unmarshall(i) as TicketDynamoItem);
  const lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  const newNextToken = lastKey
    ? Buffer.from(JSON.stringify(lastKey)).toString('base64')
    : undefined;

  return { tickets, nextToken: newNextToken };
}

/**
 * Lists waitlisted tickets for an event, sorted by waitlistPosition ascending.
 * Queries main table with PK prefix and status filter.
 */
export async function listWaitlistedTickets(
  orgId: string,
  eventId: string,
  tenantId: string,
  limit: number,
  nextToken?: string,
): Promise<{ tickets: TicketDynamoItem[]; nextToken?: string }> {
  const exclusiveStartKey = nextToken
    ? (JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8')) as Record<string, AttributeValue>)
    : undefined;

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK begins_with :pkPrefix',
      FilterExpression: 'tenantId = :tenantId AND SK = :sk AND #status = :waitlisted',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':pkPrefix': `ORG#${orgId}#EVENT#${eventId}#TICKET#`,
        ':tenantId': tenantId,
        ':sk': 'METADATA',
        ':waitlisted': 'Waitlisted',
      }),
      Limit: Math.min(limit * 3, 300), // over-fetch to allow in-memory sort
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const tickets = (result.Items ?? [])
    .map((i) => unmarshall(i) as TicketDynamoItem)
    .sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0))
    .slice(0, limit);

  const lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  const newNextToken = lastKey
    ? Buffer.from(JSON.stringify(lastKey)).toString('base64')
    : undefined;

  return { tickets, nextToken: newNextToken };
}

/**
 * Counts confirmed tickets for an event by querying the main table.
 */
export async function countConfirmedTickets(
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
        FilterExpression: 'tenantId = :tenantId AND SK = :sk AND #status = :confirmed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':pkPrefix': `ORG#${orgId}#EVENT#${eventId}#TICKET#`,
          ':tenantId': tenantId,
          ':sk': 'METADATA',
          ':confirmed': 'Confirmed',
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

/**
 * Gets the current max waitlist position for an event.
 */
export async function getMaxWaitlistPosition(
  orgId: string,
  eventId: string,
  tenantId: string,
): Promise<number> {
  let maxPos = 0;
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK begins_with :pkPrefix',
        FilterExpression: 'tenantId = :tenantId AND SK = :sk AND #status = :waitlisted',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':pkPrefix': `ORG#${orgId}#EVENT#${eventId}#TICKET#`,
          ':tenantId': tenantId,
          ':sk': 'METADATA',
          ':waitlisted': 'Waitlisted',
        }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const raw of result.Items ?? []) {
      const t = unmarshall(raw) as TicketDynamoItem;
      if ((t.waitlistPosition ?? 0) > maxPos) {
        maxPos = t.waitlistPosition ?? 0;
      }
    }

    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);

  return maxPos;
}

/**
 * Cancels a ticket by setting status = Cancelled.
 * Includes tenantId condition to prevent cross-org writes.
 */
export async function cancelTicket(
  orgId: string,
  eventId: string,
  ticketId: string,
  tenantId: string,
): Promise<TicketDynamoItem> {
  const now = nowIso();

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({
          PK: `ORG#${orgId}#EVENT#${eventId}#TICKET#${ticketId}`,
          SK: 'METADATA',
        }),
        UpdateExpression: 'SET #status = :cancelled, updatedAt = :now',
        ConditionExpression:
          'attribute_exists(PK) AND tenantId = :tenantId AND #status <> :alreadyCancelled',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':cancelled': 'Cancelled',
          ':alreadyCancelled': 'Cancelled',
          ':tenantId': tenantId,
          ':now': now,
        }),
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      throw Object.assign(new Error('Ticket not found or access denied.'), {
        statusCode: 403,
        errorCode: 'ticket.access_denied',
      });
    }

    return unmarshall(result.Attributes) as TicketDynamoItem;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Ticket not found, already cancelled, or access denied.'), {
        statusCode: 403,
        errorCode: 'ticket.access_denied',
      });
    }
    throw err;
  }
}

/**
 * Finds the waitlisted ticket with the lowest waitlistPosition (FIFO promotion).
 */
export async function findNextWaitlistTicket(
  orgId: string,
  eventId: string,
  tenantId: string,
): Promise<TicketDynamoItem | null> {
  const { tickets } = await listWaitlistedTickets(orgId, eventId, tenantId, 1);
  return tickets.length > 0 ? tickets[0] : null;
}

/**
 * Atomically promotes a waitlist ticket to Confirmed and enqueues an SQS notification.
 * Uses TransactWriteItems for atomicity.
 */
export async function promoteWaitlistTicket(
  orgId: string,
  eventId: string,
  ticketId: string,
  tenantId: string,
  sqsQueueUrl: string,
): Promise<TicketDynamoItem | null> {
  const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
  const now = nowIso();

  // First fetch the ticket to get current data
  const ticket = await getTicketById(orgId, eventId, ticketId, tenantId);
  if (!ticket || ticket.status !== 'Waitlisted') return null;

  try {
    // Use transact write to atomically update ticket status
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: marshall({
                PK: `ORG#${orgId}#EVENT#${eventId}#TICKET#${ticketId}`,
                SK: 'METADATA',
              }),
              UpdateExpression:
                'SET #status = :confirmed, updatedAt = :now REMOVE waitlistPosition',
              ConditionExpression:
                'attribute_exists(PK) AND tenantId = :tenantId AND #status = :waitlisted',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: marshall({
                ':confirmed': 'Confirmed',
                ':waitlisted': 'Waitlisted',
                ':tenantId': tenantId,
                ':now': now,
              }),
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return null; // concurrent modification — safe to skip
    }
    throw err;
  }

  // Enqueue promotion notification (non-critical — swallow error)
  try {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: sqsQueueUrl,
        MessageBody: JSON.stringify({
          type: 'ticket.waitlist_promoted',
          ticketId,
          orgId,
          eventId,
          memberId: ticket.memberId,
          guestEmail: ticket.guestEmail,
          timestamp: now,
        }),
      }),
    );
  } catch {
    // Non-fatal: log but don't fail the promotion
    process.stderr.write(`[tickets] Failed to enqueue waitlist promotion notification for ticket ${ticketId}\n`);
  }

  // Return updated ticket
  return getTicketById(orgId, eventId, ticketId, tenantId);
}
