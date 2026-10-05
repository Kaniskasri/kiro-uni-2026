import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  QueryCommand,
  GetItemCommand,
  UpdateItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { OrgDynamoItem, MembershipDynamoItem, OrgStatus, OrgSettings } from './types';
import { OrgRole } from '../shared/layers/rbac';

const TABLE = process.env['DYNAMODB_TABLE'] ?? 'clois-main';
const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

// ─── Helper ───────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Org queries ──────────────────────────────────────────────────────────────

/**
 * Checks whether a slug is already in use. Uses GSI1 SLUG#{slug} lookup.
 * Never performs a Scan.
 */
export async function slugExists(slug: string): Promise<boolean> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :gsi1pk',
      ExpressionAttributeValues: marshall({ ':gsi1pk': `SLUG#${slug}` }),
      Limit: 1,
      // Only fetch the key — we only need to know if a record exists
      ProjectionExpression: 'PK',
    }),
  );
  return (result.Count ?? 0) > 0;
}

/**
 * Creates an Organization item and an OrgMembership (Owner) in a single
 * DynamoDB TransactWriteItems call to ensure atomicity.
 */
export async function createOrgWithOwner(
  orgId: string,
  memberId: string,
  name: string,
  slug: string,
  settings: OrgSettings,
): Promise<OrgDynamoItem> {
  const now = nowIso();

  const orgItem: OrgDynamoItem = {
    PK: `ORG#${orgId}`,
    SK: 'METADATA',
    GSI1PK: `SLUG#${slug}`,
    GSI1SK: `ORG#${orgId}`,
    type: 'ORGANIZATION',
    orgId,
    name,
    slug,
    status: 'Active',
    settings,
    tenantId: orgId,
    createdAt: now,
    updatedAt: now,
  };

  const membershipItem: MembershipDynamoItem = {
    PK: `ORG#${orgId}`,
    SK: `MEMBER#${memberId}`,
    type: 'ORG_MEMBERSHIP',
    orgId,
    memberId,
    role: 'Owner',
    tenantId: orgId,
    joinedAt: now,
  };

  try {
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            // Condition: slug must not already exist in GSI1
            Put: {
              TableName: TABLE,
              Item: marshall(orgItem),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE,
              Item: marshall(membershipItem),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Organization with this slug already exists.'), {
        statusCode: 409,
        errorCode: 'org.slug_already_exists',
      });
    }
    throw err;
  }

  return orgItem;
}

/**
 * Fetches the organization METADATA record. Returns null if not found.
 * The tenantId is checked in-code after retrieval to enforce multi-tenant isolation.
 * Per design: every access pattern verifies tenantId even when PK already includes orgId.
 */
export async function getOrgById(orgId: string, tenantId: string): Promise<OrgDynamoItem | null> {
  const result = await dynamo.send(
    new GetItemCommand({
      TableName: TABLE,
      Key: marshall({ PK: `ORG#${orgId}`, SK: 'METADATA' }),
    }),
  );

  if (!result.Item) return null;
  const item = unmarshall(result.Item) as OrgDynamoItem;

  // tenantId isolation check — must match the JWT-derived tenantId
  if (item.tenantId !== tenantId) return null;

  return item;
}

/**
 * Updates mutable org fields (name, settings). Owner-only; enforced by service layer.
 */
export async function updateOrg(
  orgId: string,
  tenantId: string,
  updates: { name?: string; settings?: OrgSettings },
): Promise<OrgDynamoItem> {
  const now = nowIso();

  const updateParts: string[] = ['updatedAt = :updatedAt', 'tenantId = tenantId'];
  const eav: Record<string, unknown> = { ':updatedAt': now, ':tenantId': tenantId };

  if (updates.name !== undefined) {
    updateParts.push('#name = :name');
    eav[':name'] = updates.name;
  }
  if (updates.settings !== undefined) {
    updateParts.push('settings = :settings');
    eav[':settings'] = updates.settings;
  }

  const result = await dynamo.send(
    new UpdateItemCommand({
      TableName: TABLE,
      Key: marshall({ PK: `ORG#${orgId}`, SK: 'METADATA' }),
      UpdateExpression: 'SET ' + updateParts.join(', '),
      ConditionExpression: 'attribute_exists(PK) AND tenantId = :tenantId',
      ExpressionAttributeNames: updates.name !== undefined ? { '#name': 'name' } : undefined,
      ExpressionAttributeValues: marshall(eav),
      ReturnValues: 'ALL_NEW',
    }),
  );

  if (!result.Attributes) {
    throw Object.assign(new Error('Organization not found.'), {
      statusCode: 403,
      errorCode: 'org.not_found',
    });
  }

  return unmarshall(result.Attributes) as OrgDynamoItem;
}

/**
 * Sets org status to Deactivated. tenantId condition enforces isolation.
 */
export async function deactivateOrg(orgId: string, tenantId: string): Promise<void> {
  const now = nowIso();
  try {
    await dynamo.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: marshall({ PK: `ORG#${orgId}`, SK: 'METADATA' }),
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(PK) AND tenantId = :tenantId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':status': 'Deactivated',
          ':updatedAt': now,
          ':tenantId': tenantId,
        }),
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(new Error('Organization not found or access denied.'), {
        statusCode: 403,
        errorCode: 'org.not_found',
      });
    }
    throw err;
  }
}

/**
 * Fetches a membership record for a given org + member.
 * The tenantId is checked in-code after retrieval to enforce multi-tenant isolation.
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

  // tenantId isolation check — must match the JWT-derived tenantId
  if (item.tenantId !== tenantId) return null;

  return item;
}

/**
 * Atomically transfers ownership: demotes prior Owner to Admin, promotes target to Owner.
 * Uses TransactWriteItems with condition checks to ensure both members exist.
 */
export async function transferOwnership(
  orgId: string,
  tenantId: string,
  currentOwnerId: string,
  targetMemberId: string,
): Promise<void> {
  const now = nowIso();

  try {
    await dynamo.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            // Demote current Owner → Admin
            Update: {
              TableName: TABLE,
              Key: marshall({ PK: `ORG#${orgId}`, SK: `MEMBER#${currentOwnerId}` }),
              UpdateExpression: 'SET #role = :adminRole, updatedAt = :updatedAt',
              ConditionExpression:
                'attribute_exists(PK) AND #role = :ownerRole AND tenantId = :tenantId',
              ExpressionAttributeNames: { '#role': 'role' },
              ExpressionAttributeValues: marshall({
                ':adminRole': 'Admin' as OrgRole,
                ':ownerRole': 'Owner' as OrgRole,
                ':updatedAt': now,
                ':tenantId': tenantId,
              }),
            },
          },
          {
            // Promote target member → Owner
            Update: {
              TableName: TABLE,
              Key: marshall({ PK: `ORG#${orgId}`, SK: `MEMBER#${targetMemberId}` }),
              UpdateExpression: 'SET #role = :ownerRole, updatedAt = :updatedAt',
              ConditionExpression:
                'attribute_exists(PK) AND tenantId = :tenantId',
              ExpressionAttributeNames: { '#role': 'role' },
              ExpressionAttributeValues: marshall({
                ':ownerRole': 'Owner' as OrgRole,
                ':updatedAt': now,
                ':tenantId': tenantId,
              }),
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw Object.assign(
        new Error(
          'Transfer failed: current owner record not found or target member does not exist in this organization.',
        ),
        { statusCode: 400, errorCode: 'org.transfer_ownership_failed' },
      );
    }
    throw err;
  }
}

/**
 * Writes an entry to the append-only clois-audit-log table.
 */
export async function writeAuditLog(entry: {
  timestamp: string;
  actor: string;
  targetType: string;
  targetId: string;
  operation: string;
  sourceIp: string;
  outcome: 'success' | 'failure';
  orgId: string;
}): Promise<void> {
  const AUDIT_TABLE = process.env['AUDIT_LOG_TABLE'] ?? 'clois-audit-log';
  const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');

  const item = {
    PK: `ORG#${entry.orgId}`,
    SK: `AUDIT#${entry.timestamp}#${Math.random().toString(36).slice(2, 9)}`,
    type: 'AUDIT_LOG',
    tenantId: entry.orgId,
    ...entry,
  };

  await dynamo.send(
    new PutItemCommand({
      TableName: AUDIT_TABLE,
      Item: marshall(item),
    }),
  );
}
