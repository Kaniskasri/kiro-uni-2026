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
import { NotificationDynamoItem, OptOutDynamoItem, DeliveryStatus } from './types';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Opt-out ──────────────────────────────────────────────────────────────────

/**
 * Checks whether a member has opted out of email notifications for a given org.
 */
export async function isEmailOptedOut(memberId: string, orgId: string): Promise<boolean> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({
        PK: `MEMBER#${memberId}`,
        SK: `OPTOUT#ORG#${orgId}`,
      }),
    }),
  );
  return !!result.Item;
}

/**
 * Sets or clears the email opt-out flag for a member+org pair.
 */
export async function setEmailOptOut(
  memberId: string,
  orgId: string,
  optedOut: boolean,
): Promise<void> {
  const now = nowIso();

  if (optedOut) {
    const item: OptOutDynamoItem = {
      PK: `MEMBER#${memberId}`,
      SK: `OPTOUT#ORG#${orgId}`,
      type: 'EMAIL_OPT_OUT',
      memberId,
      orgId,
      tenantId: orgId,
      optedOutAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: marshall(item),
      }),
    );
  } else {
    // Remove opt-out record by overwriting with a "not opted out" marker — we use
    // a conditional delete pattern: just remove the item entirely.
    const { DeleteItemCommand } = await import('@aws-sdk/client-dynamodb');
    await dynamo.send(
      new DeleteItemCommand({
        TableName: TABLE,
        Key: marshall({
          PK: `MEMBER#${memberId}`,
          SK: `OPTOUT#ORG#${orgId}`,
        }),
      }),
    );
  }
}

// ─── Notification CRUD ────────────────────────────────────────────────────────

/**
 * Persists an in-app notification record to DynamoDB.
 */
export async function createNotification(
  item: Omit<NotificationDynamoItem, 'createdAt' | 'updatedAt'>,
): Promise<NotificationDynamoItem> {
  const now = nowIso();
  const fullItem: NotificationDynamoItem = { ...item, createdAt: now, updatedAt: now };

  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall(fullItem, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(PK) OR (PK = :pk AND SK = :sk)',
      ExpressionAttributeValues: marshall({
        ':pk': fullItem.PK,
        ':sk': fullItem.SK,
      }),
    }),
  );

  return fullItem;
}

/**
 * Updates the delivery status of a notification.
 * tenantId condition enforces multi-tenant isolation.
 */
export async function updateNotificationStatus(
  memberId: string,
  notificationId: string,
  tenantId: string,
  status: DeliveryStatus,
): Promise<void> {
  const now = nowIso();

  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({
          PK: `MEMBER#${memberId}`,
          SK: `NOTIFICATION#${notificationId}`,
        }),
        UpdateExpression: 'SET deliveryStatus = :status, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK) AND tenantId = :tenantId',
        ExpressionAttributeValues: marshall({
          ':status': status,
          ':tenantId': tenantId,
          ':now': now,
        }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return; // Already gone — idempotent
    }
    throw err;
  }
}

/**
 * Marks a notification as read.
 */
export async function markNotificationRead(
  memberId: string,
  notificationId: string,
  tenantId: string,
): Promise<NotificationDynamoItem | null> {
  const now = nowIso();

  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({
          PK: `MEMBER#${memberId}`,
          SK: `NOTIFICATION#${notificationId}`,
        }),
        UpdateExpression: 'SET #read = :true, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK) AND tenantId = :tenantId',
        ExpressionAttributeNames: { '#read': 'read' },
        ExpressionAttributeValues: marshall({
          ':true': true,
          ':tenantId': tenantId,
          ':now': now,
        }),
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) return null;
    return unmarshall(result.Attributes) as NotificationDynamoItem;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return null;
    }
    throw err;
  }
}

/**
 * Paginated list of notifications for a member.
 * Queries PK = MEMBER#{memberId}, SK begins_with NOTIFICATION#
 */
export async function listNotificationsForMember(
  memberId: string,
  tenantId: string,
  limit: number,
  nextToken?: string,
): Promise<{ notifications: NotificationDynamoItem[]; nextToken?: string }> {
  const exclusiveStartKey = nextToken
    ? (JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8')) as Record<string, AttributeValue>)
    : undefined;

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: marshall({
        ':pk': `MEMBER#${memberId}`,
        ':skPrefix': 'NOTIFICATION#',
        ':tenantId': tenantId,
      }),
      ScanIndexForward: false, // newest first
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const notifications = (result.Items ?? []).map((i) => unmarshall(i) as NotificationDynamoItem);
  const lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  const newNextToken = lastKey
    ? Buffer.from(JSON.stringify(lastKey)).toString('base64')
    : undefined;

  return { notifications, nextToken: newNextToken };
}
