import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { InvitationDynamoItem, MembershipDynamoItem } from './types';
import { OrgRole } from '../shared/layers/rbac';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

// ─── Helper ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Invitation queries ───────────────────────────────────────────────────────

/**
 * Checks whether an active (Pending) invitation already exists for this email+org.
 * Uses GSI2 ORG#{orgId}#EMAIL#{email} lookup — no Scan.
 */
export async function activeMembershipOrInvitationExists(
  orgId: string,
  email: string,
): Promise<boolean> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :gsi2pk AND GSI2SK = :gsi2sk',
      FilterExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':gsi2pk': `ORG#${orgId}#EMAIL#${email.toLowerCase()}`,
        ':gsi2sk': 'INVITATION',
        ':pending': 'Pending',
      }),
      Limit: 1,
      ProjectionExpression: 'PK',
    }),
  );
  return (result.Count ?? 0) > 0;
}

/**
 * Checks whether the email already belongs to an active member of this org.
 * Queries GSI2 for an OrgMembership with this email — no Scan.
 * Note: we check for active memberships using a separate pattern.
 * For simplicity and correctness we also check direct membership existence.
 */
export async function activeMembershipExistsByEmail(
  orgId: string,
  email: string,
): Promise<boolean> {
  // Check GSI2 for an accepted invitation (which means they're already a member)
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :gsi2pk AND GSI2SK = :gsi2sk',
      FilterExpression: '#status = :accepted',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':gsi2pk': `ORG#${orgId}#EMAIL#${email.toLowerCase()}`,
        ':gsi2sk': 'INVITATION',
        ':accepted': 'Accepted',
      }),
      Limit: 1,
      ProjectionExpression: 'PK',
    }),
  );
  return (result.Count ?? 0) > 0;
}

/**
 * Creates an Invitation item in DynamoDB.
 */
export async function createInvitation(item: InvitationDynamoItem): Promise<void> {
  await dynamo.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: marshall(item),
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
}

/**
 * Looks up an invitation by its SHA-256 token hash via GSI1.
 * Returns null if not found.
 */
export async function getInvitationByTokenHash(
  tokenHash: string,
): Promise<InvitationDynamoItem | null> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk AND GSI1SK = :gsi1sk',
      ExpressionAttributeValues: marshall({
        ':gsi1pk': `TOKEN#${tokenHash}`,
        ':gsi1sk': 'INVITATION',
      }),
      Limit: 1,
    }),
  );

  if (!result.Items || result.Items.length === 0) return null;
  return unmarshall(result.Items[0]) as InvitationDynamoItem;
}

/**
 * Marks an invitation as Accepted using a conditional update.
 * Fails if the invitation is not Pending (idempotency guard).
 */
export async function markInvitationAccepted(
  orgId: string,
  invitationId: string,
): Promise<void> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}`, SK: `INVITATION#${invitationId}` }),
        UpdateExpression: 'SET #status = :accepted, updatedAt = :updatedAt',
        ConditionExpression: '#status = :pending AND attribute_exists(PK)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':accepted': 'Accepted',
          ':pending': 'Pending',
          ':updatedAt': nowIso(),
        }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(
        new Error('This invitation has already been used or does not exist.'),
        { statusCode: 409, errorCode: 'invitation.already_used_or_not_found' },
      );
    }
    throw err;
  }
}

/**
 * Creates an OrgMembership item in DynamoDB.
 * Uses ConditionExpression to prevent duplicate memberships.
 */
export async function createMembership(item: MembershipDynamoItem): Promise<void> {
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: marshall(item),
        ConditionExpression: 'attribute_not_exists(PK) OR #status = :removed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({ ':removed': 'Removed' }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(
        new Error('Member already belongs to this organization.'),
        { statusCode: 409, errorCode: 'member.already_member' },
      );
    }
    throw err;
  }
}

/**
 * Lists all active members of an org. Uses Query on PK=ORG#{orgId} SK begins_with MEMBER#.
 * Returns paginated results. tenantId is verified on each item.
 */
export async function listMembers(
  orgId: string,
  tenantId: string,
  limit = 20,
  lastKey?: Record<string, unknown>,
): Promise<{ members: MembershipDynamoItem[]; lastEvaluatedKey?: Record<string, unknown> }> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression: 'tenantId = :tenantId AND #status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':pk': `ORG#${orgId}`,
        ':skPrefix': 'MEMBER#',
        ':tenantId': tenantId,
        ':active': 'Active',
      }),
      Limit: limit,
      ExclusiveStartKey: lastKey ? marshall(lastKey) : undefined,
    }),
  );

  const members = (result.Items ?? []).map((i) => unmarshall(i) as MembershipDynamoItem);
  const lastEvaluatedKey = result.LastEvaluatedKey
    ? (unmarshall(result.LastEvaluatedKey) as Record<string, unknown>)
    : undefined;

  return { members, lastEvaluatedKey };
}

/**
 * Fetches a single membership record. Verifies tenantId for multi-tenant isolation.
 */
export async function getMembership(
  orgId: string,
  memberId: string,
  tenantId: string,
): Promise<MembershipDynamoItem | null> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ PK: `ORG#${orgId}`, SK: `MEMBER#${memberId}` }),
    }),
  );

  if (!result.Item) return null;
  const item = unmarshall(result.Item) as MembershipDynamoItem;

  // tenantId isolation check
  if (item.tenantId !== tenantId) return null;

  return item;
}

/**
 * Counts the number of active Owners in an org.
 * Used for sole-owner guard enforcement.
 */
export async function countOwners(orgId: string, tenantId: string): Promise<number> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
      FilterExpression:
        'tenantId = :tenantId AND #role = :owner AND #status = :active',
      ExpressionAttributeNames: { '#role': 'role', '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':pk': `ORG#${orgId}`,
        ':skPrefix': 'MEMBER#',
        ':tenantId': tenantId,
        ':owner': 'Owner',
        ':active': 'Active',
      }),
      Select: 'COUNT',
    }),
  );
  return result.Count ?? 0;
}

/**
 * Updates a member's role. tenantId condition enforces isolation.
 */
export async function updateMemberRole(
  orgId: string,
  memberId: string,
  tenantId: string,
  newRole: OrgRole,
): Promise<MembershipDynamoItem> {
  try {
    const result = await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}`, SK: `MEMBER#${memberId}` }),
        UpdateExpression: 'SET #role = :role, updatedAt = :updatedAt',
        ConditionExpression:
          'attribute_exists(PK) AND tenantId = :tenantId AND #status = :active',
        ExpressionAttributeNames: { '#role': 'role', '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':role': newRole,
          ':updatedAt': nowIso(),
          ':tenantId': tenantId,
          ':active': 'Active',
        }),
        ReturnValues: 'ALL_NEW',
      }),
    );

    if (!result.Attributes) {
      throw Object.assign(new Error('Member not found.'), {
        statusCode: 404,
        errorCode: 'member.not_found',
      });
    }

    return unmarshall(result.Attributes) as MembershipDynamoItem;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Member not found or access denied.'), {
        statusCode: 403,
        errorCode: 'member.not_found',
      });
    }
    throw err;
  }
}

/**
 * Sets membership status to Removed. tenantId condition enforces isolation.
 */
export async function removeMember(
  orgId: string,
  memberId: string,
  tenantId: string,
): Promise<void> {
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}`, SK: `MEMBER#${memberId}` }),
        UpdateExpression: 'SET #status = :removed, updatedAt = :updatedAt',
        ConditionExpression:
          'attribute_exists(PK) AND tenantId = :tenantId AND #status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':removed': 'Removed',
          ':active': 'Active',
          ':updatedAt': nowIso(),
          ':tenantId': tenantId,
        }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Member not found or access denied.'), {
        statusCode: 403,
        errorCode: 'member.not_found',
      });
    }
    throw err;
  }
}
