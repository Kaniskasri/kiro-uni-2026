import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import * as aiService from './service';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' }),
);
const TABLE = process.env['MAIN_TABLE'] ?? 'clois-main';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(body: unknown, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function getAuthContext(event: APIGatewayProxyEvent): {
  orgId: string;
  memberId: string;
  role: string;
  sourceIp: string;
} {
  const ctx = event.requestContext?.authorizer as
    | { orgId?: string; memberId?: string; role?: string }
    | undefined;
  const orgId = ctx?.orgId ?? '';
  const memberId = ctx?.memberId ?? '';
  const role = ctx?.role ?? '';

  if (!orgId || !memberId || !role) {
    throw httpError(401, 'auth.unauthorized', 'Missing authorization context');
  }

  return {
    orgId,
    memberId,
    role,
    sourceIp: event.requestContext?.identity?.sourceIp ?? '0.0.0.0',
  };
}

async function getCompletedEventCount(orgId: string, tenantId: string): Promise<number> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':pk': `ORG#${orgId}#STATUS#Completed`,
        ':tenantId': tenantId,
      },
      Select: 'COUNT',
    }),
  );
  return result.Count ?? 0;
}

async function getPreAggregatedStats(
  orgId: string,
  tenantId: string,
): Promise<aiService.CompletedEventStats[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      FilterExpression: 'tenantId = :tenantId',
      ExpressionAttributeValues: {
        ':pk': `ORG#${orgId}#STATUS#Completed`,
        ':tenantId': tenantId,
      },
      ProjectionExpression: 'startAt',
      Limit: 100,
    }),
  );

  const items = result.Items ?? [];
  // Aggregate by day-of-week × time-slot
  const stats: Record<string, { total: number; count: number }> = {};

  for (const item of items) {
    const startAt = item['startAt'] as string;
    if (!startAt) continue;
    const d = new Date(startAt);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = days[d.getUTCDay()] ?? 'Unknown';
    const hour = d.getUTCHours();
    const timeSlot = `${String(hour).padStart(2, '0')}:00`;
    const key = `${day}|${timeSlot}`;
    if (!stats[key]) stats[key] = { total: 0, count: 0 };
    stats[key].total += 70; // placeholder attendance; real impl queries tickets
    stats[key].count++;
  }

  return Object.entries(stats).map(([key, val]) => {
    const [dayOfWeek, timeSlot] = key.split('|');
    return {
      dayOfWeek: dayOfWeek ?? 'Unknown',
      timeSlot: timeSlot ?? '00:00',
      avgAttendance: Math.round((val.total / val.count) * 100) / 100,
    };
  });
}

// ─── Route handler ─────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // POST /v1/orgs/{orgId}/ai/describe-event
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/ai\/describe-event\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    let body: { title?: string; keywords?: string[]; targetAudience?: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      throw httpError(400, 'validation.invalid_json', 'Invalid JSON body');
    }

    if (!body.title) {
      throw httpError(400, 'validation.missing_fields', 'title is required');
    }

    const result = await aiService.describeEvent(
      pathOrgId,
      orgId,
      role,
      memberId,
      sourceIp,
      {
        title: body.title,
        keywords: body.keywords ?? [],
        targetAudience: body.targetAudience ?? 'general audience',
      },
    );

    return ok({ description: result.description, wordCount: result.wordCount });
  }

  // POST /v1/orgs/{orgId}/ai/suggest-schedule
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/ai\/suggest-schedule\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const completedCount = await getCompletedEventCount(pathOrgId, orgId);
    const stats = completedCount >= 5 ? await getPreAggregatedStats(pathOrgId, orgId) : [];

    const result = await aiService.suggestSchedule(
      pathOrgId,
      orgId,
      role,
      memberId,
      sourceIp,
      completedCount,
      stats,
    );

    return ok(result);
  }

  // POST /v1/orgs/{orgId}/ai/analyze-sentiment
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/ai\/analyze-sentiment\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    let body: { feedbackEntries?: string[] };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      throw httpError(400, 'validation.invalid_json', 'Invalid JSON body');
    }

    if (!Array.isArray(body.feedbackEntries)) {
      throw httpError(400, 'validation.missing_fields', 'feedbackEntries array is required');
    }

    const result = await aiService.analyzeSentiment(
      pathOrgId,
      orgId,
      role,
      memberId,
      sourceIp,
      body.feedbackEntries,
    );

    return ok(result);
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
