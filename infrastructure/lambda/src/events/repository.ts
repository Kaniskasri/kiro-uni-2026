import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ConditionalCheckFailedException,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { EventDynamoItem, EventStatus } from './types';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

// ─── Helper ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Event queries ────────────────────────────────────────────────────────────

/**
 * Creates a new Event item.
 * PK = ORG#{orgId}#EVENT#{eventId}, SK = METADATA
 * GSI2PK = ORG#{orgId}#STATUS#{status}, GSI2SK = startAt
 */
export async function createEvent(
  item: Omit<EventDynamoItem, 'createdAt' | 'updatedAt'>,
): Promise<EventDynamoItem> {
  const now = nowIso();
  const fullItem: EventDynamoItem = { ...item, createdAt: now, updatedAt: now };

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
 * Fetches a single Event by orgId + eventId.
 * tenantId condition enforces multi-tenant isolation on every read.
 * Returns null if not found OR tenantId mismatch (caller treats both as 403).
 */
export async function getEventById(
  orgId: string,
  eventId: string,
  tenantId: string,
): Promise<EventDynamoItem | null> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
    }),
  );

  if (!result.Item) return null;
  const item = unmarshall(result.Item) as EventDynamoItem;

  // tenantId isolation check — must match the JWT-derived tenantId
  if (item.tenantId !== tenantId) return null;

  return item;
}

/**
 * Lists events for an org using GSI2 (ORG#{orgId}#STATUS#{status} key).
 * If status is provided, queries that specific GSI2PK.
 * If status is omitted, iterates over all statuses to build a full list.
 * Never performs a Scan.
 */
export async function listEventsByOrg(
  orgId: string,
  tenantId: string,
  limit: number,
  status?: EventStatus,
  nextToken?: string,
): Promise<{ events: EventDynamoItem[]; nextToken?: string }> {
  const ALL_STATUSES: EventStatus[] = [
    'Draft',
    'Published',
    'Open',
    'In_Progress',
    'Completed',
    'Archived',
    'Cancelled',
  ];

  const statusesToQuery = status ? [status] : ALL_STATUSES;
  const exclusiveStartKey = nextToken
    ? (JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8')) as Record<string, AttributeValue>)
    : undefined;

  const allEvents: EventDynamoItem[] = [];
  let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

  for (const s of statusesToQuery) {
    if (allEvents.length >= limit) break;

    const remaining = limit - allEvents.length;

    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :gsi2pk',
        FilterExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: marshall({
          ':gsi2pk': `ORG#${orgId}#STATUS#${s}`,
          ':tenantId': tenantId,
        }),
        Limit: remaining,
        ScanIndexForward: true, // sorted by startAt ascending
        ExclusiveStartKey:
          !status && s !== statusesToQuery[0] ? undefined : exclusiveStartKey,
      }),
    );

    const events = (result.Items ?? []).map((i) => unmarshall(i) as EventDynamoItem);
    allEvents.push(...events);

    if (result.LastEvaluatedKey) {
      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, AttributeValue>;
    }
  }

  const newNextToken = lastEvaluatedKey
    ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64')
    : undefined;

  return { events: allEvents.slice(0, limit), nextToken: newNextToken };
}

/**
 * Updates mutable event fields and transitions GSI2PK when status changes.
 * Includes tenantId condition to prevent cross-org writes.
 */
export async function updateEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
  updates: {
    title?: string;
    description?: string;
    startAt?: string;
    endAt?: string;
    timezone?: string;
    capacity?: number;
    venueId?: string;
    address?: string;
    meetingUrl?: string;
    isVirtual?: boolean;
    status?: EventStatus;
  },
): Promise<EventDynamoItem> {
  const now = nowIso();

  const setParts: string[] = ['updatedAt = :updatedAt'];
  const eav: Record<string, unknown> = { ':updatedAt': now, ':tenantId': tenantId };
  const ean: Record<string, string> = {};

  if (updates.title !== undefined) {
    setParts.push('#title = :title');
    eav[':title'] = updates.title;
    ean['#title'] = 'title';
  }
  if (updates.description !== undefined) {
    setParts.push('description = :description');
    eav[':description'] = updates.description;
  }
  if (updates.startAt !== undefined) {
    setParts.push('startAt = :startAt');
    setParts.push('GSI2SK = :startAt');
    eav[':startAt'] = updates.startAt;
  }
  if (updates.endAt !== undefined) {
    setParts.push('endAt = :endAt');
    eav[':endAt'] = updates.endAt;
  }
  if (updates.timezone !== undefined) {
    setParts.push('#tz = :timezone');
    eav[':timezone'] = updates.timezone;
    ean['#tz'] = 'timezone';
  }
  if (updates.capacity !== undefined) {
    setParts.push('capacity = :capacity');
    eav[':capacity'] = updates.capacity;
  }
  if (updates.venueId !== undefined) {
    setParts.push('venueId = :venueId');
    eav[':venueId'] = updates.venueId;
  }
  if (updates.address !== undefined) {
    setParts.push('address = :address');
    eav[':address'] = updates.address;
  }
  if (updates.meetingUrl !== undefined) {
    setParts.push('meetingUrl = :meetingUrl');
    eav[':meetingUrl'] = updates.meetingUrl;
  }
  if (updates.isVirtual !== undefined) {
    setParts.push('isVirtual = :isVirtual');
    eav[':isVirtual'] = updates.isVirtual;
  }
  if (updates.status !== undefined) {
    setParts.push('#status = :status');
    setParts.push('GSI2PK = :gsi2pk');
    eav[':status'] = updates.status;
    eav[':gsi2pk'] = `ORG#${orgId}#STATUS#${updates.status}`;
    ean['#status'] = 'status';
  }

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
        UpdateExpression: 'SET ' + setParts.join(', '),
        ConditionExpression: 'attribute_exists(PK) AND tenantId = :tenantId',
        ExpressionAttributeNames: Object.keys(ean).length > 0 ? ean : undefined,
        ExpressionAttributeValues: marshall(eav, { removeUndefinedValues: true }),
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      throw Object.assign(new Error('Event not found or access denied.'), {
        statusCode: 403,
        errorCode: 'event.access_denied',
      });
    }

    return unmarshall(result.Attributes) as EventDynamoItem;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Event not found or access denied.'), {
        statusCode: 403,
        errorCode: 'event.access_denied',
      });
    }
    throw err;
  }
}

/**
 * Transitions an event's status with an optimistic lock on currentStatus.
 * Uses a ConditionExpression to ensure atomic state machine transitions.
 */
export async function transitionEventStatus(
  orgId: string,
  eventId: string,
  tenantId: string,
  currentStatus: EventStatus,
  newStatus: EventStatus,
): Promise<EventDynamoItem> {
  const now = nowIso();

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}#EVENT#${eventId}`, SK: 'METADATA' }),
        UpdateExpression:
          'SET #status = :newStatus, GSI2PK = :gsi2pk, updatedAt = :updatedAt',
        ConditionExpression:
          'attribute_exists(PK) AND tenantId = :tenantId AND #status = :currentStatus',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':newStatus': newStatus,
          ':gsi2pk': `ORG#${orgId}#STATUS#${newStatus}`,
          ':currentStatus': currentStatus,
          ':tenantId': tenantId,
          ':updatedAt': now,
        }),
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      throw Object.assign(new Error('Event not found or access denied.'), {
        statusCode: 403,
        errorCode: 'event.access_denied',
      });
    }

    return unmarshall(result.Attributes) as EventDynamoItem;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(
        new Error('Event not found, access denied, or concurrent state change detected.'),
        { statusCode: 403, errorCode: 'event.access_denied' },
      );
    }
    throw err;
  }
}
