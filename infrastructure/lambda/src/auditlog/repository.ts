import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandInput,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { AuditLogFilter, AuditLogItem, AuditLogPageResult } from './types';

const dynamo = new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const AUDIT_TABLE = process.env['AUDIT_LOG_TABLE'] ?? 'clois-audit-log';

/**
 * Queries the clois-audit-log table for a given org, with optional filters.
 * Uses PK = ORG#{orgId}, SK begins_with AUDIT#, with additional filter expressions
 * for date range, actor, and operation.
 */
export async function queryAuditLog(
  orgId: string,
  filter: AuditLogFilter,
): Promise<AuditLogPageResult> {
  const limit = Math.min(filter.limit ?? 20, 100);

  const expressionNames: Record<string, string> = { '#PK': 'PK', '#SK': 'SK' };
  const expressionValues: Record<string, unknown> = {
    ':pk': { S: `ORG#${orgId}` },
    ':skPrefix': { S: 'AUDIT#' },
  };

  let keyCondition = '#PK = :pk AND begins_with(#SK, :skPrefix)';
  const filterParts: string[] = [];

  // Always enforce tenantId scoping as a filter expression (defence-in-depth)
  expressionNames['#tenantId'] = 'tenantId';
  expressionValues[':tenantId'] = { S: orgId };
  filterParts.push('#tenantId = :tenantId');

  if (filter.dateFrom) {
    // SK format: AUDIT#{timestamp}#{random}  — use SK range
    // Refine key condition to also apply lower bound on SK
    expressionValues[':skFrom'] = { S: `AUDIT#${filter.dateFrom}` };
    keyCondition = '#PK = :pk AND #SK BETWEEN :skFrom AND :skTo';
    // :skTo will also be set when dateTo is present, otherwise set high sentinel
    const skTo = filter.dateTo
      ? `AUDIT#${filter.dateTo}~`  // ~ sorts after any ISO 8601 digit at that prefix
      : `AUDIT#9999-99-99T99:99:99Z~`;
    expressionValues[':skTo'] = { S: skTo };
  } else if (filter.dateTo) {
    expressionValues[':skTo'] = { S: `AUDIT#${filter.dateTo}~` };
    keyCondition = '#PK = :pk AND #SK BETWEEN :skPrefix AND :skTo';
  }

  if (filter.actor) {
    expressionNames['#actor'] = 'actor';
    expressionValues[':actor'] = { S: filter.actor };
    filterParts.push('#actor = :actor');
  }

  if (filter.operation) {
    expressionNames['#operation'] = 'operation';
    expressionValues[':operation'] = { S: filter.operation };
    filterParts.push('#operation = :operation');
  }

  const params: QueryCommandInput = {
    TableName: AUDIT_TABLE,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: expressionValues as QueryCommandInput['ExpressionAttributeValues'],
    Limit: limit,
    ScanIndexForward: false, // newest first
  };

  if (filterParts.length > 0) {
    params.FilterExpression = filterParts.join(' AND ');
  }

  if (filter.nextToken) {
    try {
      params.ExclusiveStartKey = JSON.parse(
        Buffer.from(filter.nextToken, 'base64').toString('utf-8'),
      ) as QueryCommandInput['ExclusiveStartKey'];
    } catch {
      // invalid nextToken — ignore and start from beginning
    }
  }

  const result = await dynamo.send(new QueryCommand(params));

  const items = (result.Items ?? []).map(
    (raw) => unmarshall(raw) as AuditLogItem,
  );

  let nextToken: string | undefined;
  if (result.LastEvaluatedKey) {
    nextToken = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
  }

  return { items, nextToken };
}
