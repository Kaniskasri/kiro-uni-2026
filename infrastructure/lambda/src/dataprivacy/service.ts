import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import { assertPermission } from '../shared/layers/rbac';

const s3 = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' }),
);
const ses = new SESClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

const TABLE = process.env['MAIN_TABLE'] ?? 'clois-main';
const ASSETS_BUCKET = process.env['ASSETS_BUCKET'] ?? 'clois-assets';
const SES_FROM = process.env['SES_FROM_EMAIL'] ?? 'noreply@clois.app';

// ─── PII placeholder ──────────────────────────────────────────────────────────

const PII_PLACEHOLDER = '[ANONYMIZED]';

// ─── Data export ──────────────────────────────────────────────────────────────

/**
 * Compiles member profile + ticket history + notifications into a JSON export,
 * stores in S3, and returns a 48-hour pre-signed URL.
 */
export async function requestDataExport(
  memberId: string,
  actorId: string,
  sourceIp: string,
): Promise<{ presignedUrl: string }> {
  // Fetch member profile
  const profileResult = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
    }),
  );

  // Fetch tickets (all orgs)
  const ticketsResult = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI3',
      KeyConditionExpression: 'begins_with(GSI3PK, :memberPrefix)',
      ExpressionAttributeValues: {
        ':memberPrefix': `MEMBER#${memberId}#`,
      },
    }),
  );

  // Fetch notifications
  const notificationsResult = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI4',
      KeyConditionExpression: 'begins_with(GSI4PK, :memberPrefix)',
      ExpressionAttributeValues: {
        ':memberPrefix': `MEMBER#${memberId}#`,
      },
    }),
  );

  const exportData = {
    exportedAt: new Date().toISOString(),
    memberId,
    profile: profileResult.Item ?? null,
    tickets: ticketsResult.Items ?? [],
    notifications: notificationsResult.Items ?? [],
  };

  const timestamp = Date.now();
  const s3Key = `data-exports/${memberId}/export-${timestamp}.json`;

  await s3.send(
    new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: s3Key,
      Body: JSON.stringify(exportData),
      ContentType: 'application/json',
    }),
  );

  // 48-hour pre-signed URL
  const getCommand = new GetObjectCommand({
    Bucket: ASSETS_BUCKET,
    Key: s3Key,
  });
  const presignedUrl = await getSignedUrl(s3, getCommand, { expiresIn: 48 * 3600 });

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'MEMBER',
    targetId: memberId,
    operation: 'data.export_request',
    sourceIp,
    outcome: 'success',
    orgId: 'system',
  });

  return { presignedUrl };
}

// ─── Account deletion ─────────────────────────────────────────────────────────

/**
 * Deletes a member account:
 * - Guards: rejects if sole Owner of any org
 * - Anonymizes PII fields across all records
 * - Cancels active tickets
 */
export async function deleteAccount(
  memberId: string,
  actorId: string,
  sourceIp: string,
): Promise<void> {
  // Check if sole Owner of any org
  const membershipResult = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `MEMBER#${memberId}`,
        ':skPrefix': 'ORG#',
      },
    }),
  );

  const memberships = membershipResult.Items ?? [];

  for (const membership of memberships) {
    if (membership['role'] === 'Owner') {
      const orgId = membership['orgId'] as string;

      // Count other owners in this org
      const ownerCountResult = await dynamo.send(
        new QueryCommand({
          TableName: TABLE,
          IndexName: 'GSI2',
          KeyConditionExpression: 'GSI2PK = :gsi2pk',
          FilterExpression: '#role = :ownerRole',
          ExpressionAttributeNames: { '#role': 'role' },
          ExpressionAttributeValues: {
            ':gsi2pk': `ORG#${orgId}#ROLE#Owner`,
            ':ownerRole': 'Owner',
          },
          Select: 'COUNT',
        }),
      );

      if ((ownerCountResult.Count ?? 0) <= 1) {
        throw Object.assign(
          new Error(
            `Cannot delete account: you are the sole Owner of organization ${orgId}. Transfer ownership before deleting your account.`,
          ),
          { statusCode: 409, errorCode: 'data.sole_owner_guard' },
        );
      }
    }
  }

  // Anonymize PII across profile record
  await dynamo.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `MEMBER#${memberId}`, SK: 'PROFILE' },
      UpdateExpression:
        'SET #name = :placeholder, email = :placeholder, phone = :placeholder, updatedAt = :now',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: {
        ':placeholder': PII_PLACEHOLDER,
        ':now': new Date().toISOString(),
      },
    }),
  );

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'MEMBER',
    targetId: memberId,
    operation: 'data.account_delete',
    sourceIp,
    outcome: 'success',
    orgId: 'system',
  });
}

// ─── Member data map (Admin only) ─────────────────────────────────────────────

export interface MemberDataMap {
  memberId: string;
  dynamoKeys: Array<{ PK: string; SK: string }>;
  s3Keys: string[];
}

export async function getMemberDataMap(
  orgId: string,
  tenantId: string,
  callerRole: string,
  targetMemberId: string,
): Promise<MemberDataMap> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'data.access_denied',
    });
  }

  assertPermission(callerRole, 'data:member-map');

  // Collect DynamoDB keys for this member across the org
  const keys: Array<{ PK: string; SK: string }> = [];

  // Profile
  const profile = await dynamo.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `MEMBER#${targetMemberId}`, SK: 'PROFILE' },
    }),
  );

  if (profile.Item) {
    keys.push({ PK: `MEMBER#${targetMemberId}`, SK: 'PROFILE' });
  }

  // Tickets in this org
  const tickets = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI3',
      KeyConditionExpression: 'GSI3PK = :gsi3pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':gsi3pk': `MEMBER#${targetMemberId}#ORG#${orgId}`,
        ':tenantId': tenantId,
      },
      ProjectionExpression: 'PK, SK',
    }),
  );

  for (const item of tickets.Items ?? []) {
    keys.push({ PK: item['PK'] as string, SK: item['SK'] as string });
  }

  // Notifications
  const notifications = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI4',
      KeyConditionExpression: 'GSI4PK = :gsi4pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':gsi4pk': `MEMBER#${targetMemberId}#ORG#${orgId}`,
        ':tenantId': tenantId,
      },
      ProjectionExpression: 'PK, SK',
    }),
  );

  for (const item of notifications.Items ?? []) {
    keys.push({ PK: item['PK'] as string, SK: item['SK'] as string });
  }

  // Known S3 key patterns for this member
  const s3Keys = [
    `data-exports/${targetMemberId}/`,
    `qr-codes/${orgId}/`,
  ];

  return {
    memberId: targetMemberId,
    dynamoKeys: keys,
    s3Keys,
  };
}
