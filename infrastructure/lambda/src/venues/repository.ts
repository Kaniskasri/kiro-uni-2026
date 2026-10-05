import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  QueryCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { VenueDynamoItem, BlockingEvent } from './types';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

// ─── Helper ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Venue queries ────────────────────────────────────────────────────────────

/**
 * Creates a new Venue item.
 * PK = ORG#{orgId}#VENUE#{venueId}, SK = METADATA
 * GSI1PK = ORG#{orgId}, GSI1SK = VENUE#{venueId}
 */
export async function createVenue(item: Omit<VenueDynamoItem, 'createdAt' | 'updatedAt'>): Promise<VenueDynamoItem> {
  const now = nowIso();
  const fullItem: VenueDynamoItem = { ...item, createdAt: now, updatedAt: now };

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
 * Fetches a single Venue by orgId + venueId.
 * tenantId condition enforces multi-tenant isolation on every read.
 * Returns null if not found OR tenantId mismatch (caller treats both as 403).
 */
export async function getVenueById(
  orgId: string,
  venueId: string,
  tenantId: string,
): Promise<VenueDynamoItem | null> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ PK: `ORG#${orgId}#VENUE#${venueId}`, SK: 'METADATA' }),
    }),
  );

  if (!result.Item) return null;
  const item = unmarshall(result.Item) as VenueDynamoItem;

  // tenantId isolation check — must match the JWT-derived tenantId
  if (item.tenantId !== tenantId) return null;

  return item;
}

/**
 * Lists all venues for an org using GSI1 (ORG#{orgId} prefix).
 * Never performs a Scan — always a GSI Query.
 */
export async function listVenuesByOrg(
  orgId: string,
  tenantId: string,
  limit: number,
  nextToken?: string,
): Promise<{ venues: VenueDynamoItem[]; nextToken?: string }> {
  const exclusiveStartKey = nextToken
    ? JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8'))
    : undefined;

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND begins_with(GSI1SK, :prefix)',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: marshall({
        ':gsi1pk': `ORG#${orgId}`,
        ':prefix': 'VENUE#',
        ':tenantId': tenantId,
      }),
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const venues = (result.Items ?? []).map((i) => unmarshall(i) as VenueDynamoItem);

  const newNextToken = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
    : undefined;

  return { venues, nextToken: newNextToken };
}

/**
 * Updates mutable venue fields (name, address, capacity, amenities).
 * Includes tenantId condition to prevent cross-org writes.
 */
export async function updateVenue(
  orgId: string,
  venueId: string,
  tenantId: string,
  updates: {
    name?: string;
    address?: string;
    capacity?: number;
    amenities?: string[];
  },
): Promise<VenueDynamoItem> {
  const now = nowIso();

  const setParts: string[] = ['updatedAt = :updatedAt'];
  const eav: Record<string, unknown> = { ':updatedAt': now, ':tenantId': tenantId };
  const ean: Record<string, string> = {};

  if (updates.name !== undefined) {
    setParts.push('#name = :name');
    eav[':name'] = updates.name;
    ean['#name'] = 'name';
  }
  if (updates.address !== undefined) {
    setParts.push('address = :address');
    eav[':address'] = updates.address;
  }
  if (updates.capacity !== undefined) {
    setParts.push('capacity = :capacity');
    eav[':capacity'] = updates.capacity;
  }
  if (updates.amenities !== undefined) {
    setParts.push('amenities = :amenities');
    eav[':amenities'] = updates.amenities;
  }

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}#VENUE#${venueId}`, SK: 'METADATA' }),
        UpdateExpression: 'SET ' + setParts.join(', '),
        ConditionExpression: 'attribute_exists(PK) AND tenantId = :tenantId',
        ExpressionAttributeNames: Object.keys(ean).length > 0 ? ean : undefined,
        ExpressionAttributeValues: marshall(eav),
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      throw Object.assign(new Error('Venue not found or access denied.'), {
        statusCode: 403,
        errorCode: 'venue.access_denied',
      });
    }

    return unmarshall(result.Attributes) as VenueDynamoItem;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Venue not found or access denied.'), {
        statusCode: 403,
        errorCode: 'venue.access_denied',
      });
    }
    throw err;
  }
}

/**
 * Deletes a Venue item. Includes tenantId condition to prevent cross-org deletes.
 */
export async function deleteVenue(
  orgId: string,
  venueId: string,
  tenantId: string,
): Promise<void> {
  try {
    await dynamo.send(
      new DeleteItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}#VENUE#${venueId}`, SK: 'METADATA' }),
        ConditionExpression: 'attribute_exists(PK) AND tenantId = :tenantId',
        ExpressionAttributeValues: marshall({ ':tenantId': tenantId }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Venue not found or access denied.'), {
        statusCode: 403,
        errorCode: 'venue.access_denied',
      });
    }
    throw err;
  }
}

/**
 * Checks whether any Published or Open events reference the given venueId within the org.
 * Uses GSI2 (ORG#{orgId} + status filter) — never a Scan.
 * Returns an array of blocking events (empty = safe to delete).
 */
export async function getBlockingEvents(
  orgId: string,
  venueId: string,
  tenantId: string,
): Promise<BlockingEvent[]> {
  // Query GSI2 for events in Published status
  const blockingStatuses = ['Published', 'Open'];
  const blockingEvents: BlockingEvent[] = [];

  for (const status of blockingStatuses) {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :gsi2pk AND begins_with(GSI2SK, :statusPrefix)',
        FilterExpression: 'venueId = :venueId AND tenantId = :tenantId',
        ExpressionAttributeValues: marshall({
          ':gsi2pk': `ORG#${orgId}`,
          ':statusPrefix': `${status}#`,
          ':venueId': venueId,
          ':tenantId': tenantId,
        }),
        ProjectionExpression: 'eventId, #name, #status',
        ExpressionAttributeNames: { '#name': 'name', '#status': 'status' },
      }),
    );

    const events = (result.Items ?? []).map((i) => {
      const item = unmarshall(i) as { eventId: string; name: string; status: string };
      return { eventId: item.eventId, name: item.name, status: item.status };
    });

    blockingEvents.push(...events);
  }

  return blockingEvents;
}
