import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import {
  AnnouncementAudience,
  AnnouncementDynamoItem,
  OrgMembershipItem,
  CreateAnnouncementRequest,
  Announcement,
} from './types';
import { NotificationMessage } from '../notifications/types';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const NOTIFICATION_QUEUE_URL = process.env['NOTIFICATION_QUEUE_URL'] ?? '';

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Member resolution ────────────────────────────────────────────────────────

/**
 * Resolves all member IDs in the org (for AllMembers audience).
 * Queries ORG#{orgId} PK with SK begins_with MEMBERSHIP#
 */
async function resolveAllMembers(orgId: string): Promise<string[]> {
  const memberIds: string[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression: 'tenantId = :tenantId AND #type = :mType',
        ExpressionAttributeNames: { '#type': 'type' },
        ExpressionAttributeValues: marshall({
          ':pk': `ORG#${orgId}`,
          ':skPrefix': 'MEMBERSHIP#',
          ':tenantId': orgId,
          ':mType': 'ORG_MEMBERSHIP',
        }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const membership = unmarshall(item) as OrgMembershipItem;
      if (membership.memberId) {
        memberIds.push(membership.memberId);
      }
    }

    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);

  return memberIds;
}

/**
 * Resolves confirmed attendees (ticketed members) for an event.
 * Queries ORG#{orgId}#EVENT#{eventId}#TICKET# PK prefix with Confirmed status.
 */
async function resolveEventAttendees(orgId: string, eventId: string): Promise<string[]> {
  const memberIds: string[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK begins_with :pkPrefix AND SK = :sk',
        FilterExpression: 'tenantId = :tenantId AND #status = :confirmed AND attribute_exists(memberId)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':pkPrefix': `ORG#${orgId}#EVENT#${eventId}#TICKET#`,
          ':sk': 'METADATA',
          ':tenantId': orgId,
          ':confirmed': 'Confirmed',
        }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const ticket = unmarshall(item) as { memberId?: string };
      if (ticket.memberId) {
        memberIds.push(ticket.memberId);
      }
    }

    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);

  return memberIds;
}

/**
 * Resolves members with a specific role in the org.
 */
async function resolveMembersByRole(orgId: string, role: string): Promise<string[]> {
  const memberIds: string[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await dynamo.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
        FilterExpression: 'tenantId = :tenantId AND #type = :mType AND #role = :role',
        ExpressionAttributeNames: { '#type': 'type', '#role': 'role' },
        ExpressionAttributeValues: marshall({
          ':pk': `ORG#${orgId}`,
          ':skPrefix': 'MEMBERSHIP#',
          ':tenantId': orgId,
          ':mType': 'ORG_MEMBERSHIP',
          ':role': role,
        }),
        ExclusiveStartKey: lastKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const membership = unmarshall(item) as OrgMembershipItem;
      if (membership.memberId) {
        memberIds.push(membership.memberId);
      }
    }

    lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (lastKey);

  return memberIds;
}

/**
 * Resolves the target member set for an announcement audience.
 * Deduplicates the result.
 */
export async function resolveAudienceMembers(
  orgId: string,
  audience: AnnouncementAudience,
): Promise<string[]> {
  let raw: string[] = [];

  switch (audience.type) {
    case 'AllMembers':
      raw = await resolveAllMembers(orgId);
      break;

    case 'EventAttendees': {
      if (!audience.eventId) {
        throw Object.assign(new Error('eventId is required for EventAttendees audience'), {
          statusCode: 400,
          errorCode: 'announcement.missing_event_id',
        });
      }
      raw = await resolveEventAttendees(orgId, audience.eventId);
      break;
    }

    case 'Role': {
      if (!audience.role) {
        throw Object.assign(new Error('role is required for Role audience'), {
          statusCode: 400,
          errorCode: 'announcement.missing_role',
        });
      }
      raw = await resolveMembersByRole(orgId, audience.role);
      break;
    }

    case 'Manual': {
      if (!audience.memberIds || audience.memberIds.length === 0) {
        throw Object.assign(new Error('memberIds are required for Manual audience'), {
          statusCode: 400,
          errorCode: 'announcement.missing_member_ids',
        });
      }
      if (audience.memberIds.length > 500) {
        throw Object.assign(new Error('Manual audience cannot exceed 500 members'), {
          statusCode: 400,
          errorCode: 'announcement.audience_too_large',
        });
      }
      raw = audience.memberIds;
      break;
    }

    default:
      throw Object.assign(new Error('Invalid audience type'), {
        statusCode: 400,
        errorCode: 'announcement.invalid_audience_type',
      });
  }

  // Deduplicate
  return [...new Set(raw)];
}

// ─── Enqueue notifications ────────────────────────────────────────────────────

/**
 * Enqueues one SQS notification message per target member.
 */
async function enqueueNotifications(
  orgId: string,
  announcementId: string,
  memberIds: string[],
  subject: string,
  body: string,
  createdBy: string,
): Promise<void> {
  const enqueuedAt = nowIso();

  // SQS batch size is 10; send in batches
  const batchSize = 10;
  for (let i = 0; i < memberIds.length; i += batchSize) {
    const batch = memberIds.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (memberId) => {
        const msg: NotificationMessage = {
          version: '1',
          notificationId: randomUUID(),
          orgId,
          memberId,
          type: 'announcement',
          subject,
          bodyText: body,
          inAppMessage: subject,
          enqueuedAt,
          metadata: { announcementId, sentBy: createdBy },
        };

        await sqs.send(
          new SendMessageCommand({
            QueueUrl: NOTIFICATION_QUEUE_URL,
            MessageBody: JSON.stringify(msg),
            MessageGroupId: orgId, // FIFO queue support
            MessageDeduplicationId: msg.notificationId,
          }),
        );
      }),
    );
  }
}

// ─── Announcement persistence ─────────────────────────────────────────────────

async function saveAnnouncement(
  item: Omit<AnnouncementDynamoItem, 'createdAt' | 'updatedAt'>,
): Promise<AnnouncementDynamoItem> {
  const now = nowIso();
  const fullItem: AnnouncementDynamoItem = { ...item, createdAt: now, updatedAt: now };

  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall(fullItem, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return fullItem;
}

// ─── Public service functions ─────────────────────────────────────────────────

export async function createAnnouncement(
  orgId: string,
  tenantId: string,
  createdBy: string,
  req: CreateAnnouncementRequest,
): Promise<Announcement> {
  const { subject, body, audience } = req;

  // Validate subject and body
  if (!subject || subject.trim().length === 0 || subject.length > 500) {
    throw Object.assign(new Error('subject must be 1–500 characters'), {
      statusCode: 400,
      errorCode: 'announcement.invalid_subject',
    });
  }
  if (!body || body.trim().length === 0 || body.length > 10000) {
    throw Object.assign(new Error('body must be 1–10000 characters'), {
      statusCode: 400,
      errorCode: 'announcement.invalid_body',
    });
  }

  // Resolve target members
  const memberIds = await resolveAudienceMembers(orgId, audience);

  const announcementId = randomUUID();
  const now = nowIso();

  // Persist announcement record
  const saved = await saveAnnouncement({
    PK: `ORG#${orgId}`,
    SK: `ANNOUNCEMENT#${announcementId}`,
    GSI2PK: `ORG#${orgId}#ANNOUNCEMENTS`,
    GSI2SK: `ANNOUNCEMENT#${now}#${announcementId}`,
    type: 'ANNOUNCEMENT',
    announcementId,
    orgId,
    tenantId,
    subject,
    body,
    audience,
    recipientCount: memberIds.length,
    createdBy,
  });

  // Enqueue one notification per member (fire-and-forget failure is logged)
  if (NOTIFICATION_QUEUE_URL && memberIds.length > 0) {
    await enqueueNotifications(orgId, announcementId, memberIds, subject, body, createdBy);
  }

  return {
    announcementId: saved.announcementId,
    orgId: saved.orgId,
    subject: saved.subject,
    body: saved.body,
    audience: saved.audience,
    recipientCount: saved.recipientCount,
    createdBy: saved.createdBy,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

export async function listAnnouncements(
  orgId: string,
  tenantId: string,
  limit: number,
  nextToken?: string,
): Promise<{ announcements: Announcement[]; nextToken?: string }> {
  const exclusiveStartKey = nextToken
    ? (JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8')) as Record<string, AttributeValue>)
    : undefined;

  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :gsi2pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: marshall({
        ':gsi2pk': `ORG#${orgId}#ANNOUNCEMENTS`,
        ':tenantId': tenantId,
      }),
      ScanIndexForward: false, // newest first
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey,
    }),
  );

  const announcements = (result.Items ?? []).map((i) => {
    const item = unmarshall(i) as AnnouncementDynamoItem;
    return {
      announcementId: item.announcementId,
      orgId: item.orgId,
      subject: item.subject,
      body: item.body,
      audience: item.audience,
      recipientCount: item.recipientCount,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  const lastKey = result.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  const newNextToken = lastKey
    ? Buffer.from(JSON.stringify(lastKey)).toString('base64')
    : undefined;

  return { announcements, nextToken: newNextToken };
}
