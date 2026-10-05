import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });

export interface AuditLogEntry {
  timestamp: string;       // UTC ISO 8601
  actor: string;           // memberId or "system"
  targetType: string;      // e.g., "ORGANIZATION", "INVITATION", "MEMBER"
  targetId: string;
  operation: string;       // e.g., "org.deactivate", "member.invite"
  sourceIp: string;
  outcome: 'success' | 'failure';
  orgId: string;
  metadata?: Record<string, unknown>; // operation-specific, no PII for AI entries
}

/**
 * Writes an immutable entry to the append-only clois-audit-log table.
 * Application IAM roles have PutItem only — no UpdateItem or DeleteItem.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<void> {
  const AUDIT_TABLE = process.env['AUDIT_LOG_TABLE'] ?? 'clois-audit-log';

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
