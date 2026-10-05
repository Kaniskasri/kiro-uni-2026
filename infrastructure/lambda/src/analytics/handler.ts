import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import * as analyticsService from './service';

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

// ─── Route handler ─────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // GET /v1/orgs/{orgId}/events/{eventId}/analytics
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/analytics\/?$/.test(path)
  ) {
    const { orgId, memberId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId is required');
    }

    const result = await analyticsService.getEventAnalytics(
      pathOrgId,
      eventId,
      orgId,
      role,
      memberId,
    );

    return ok({ analytics: result });
  }

  // GET /v1/orgs/{orgId}/events/{eventId}/analytics/export
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/analytics\/export\/?$/.test(path)
  ) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];
    const format = (event.queryStringParameters?.['format'] ?? 'csv') as 'csv' | 'pdf';

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId is required');
    }

    if (format !== 'csv' && format !== 'pdf') {
      throw httpError(400, 'validation.invalid_format', 'format must be csv or pdf');
    }

    const result = await analyticsService.getAnalyticsExport(
      pathOrgId,
      eventId,
      orgId,
      role,
      format,
    );

    return ok({ presignedUrl: result.presignedUrl });
  }

  // POST /v1/orgs/{orgId}/analytics/trend-report
  if (
    method === 'POST' &&
    /^\/v1\/orgs\/[^/]+\/analytics\/trend-report\/?$/.test(path)
  ) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    let body: { dateRangeStart: string; dateRangeEnd: string };
    try {
      body = JSON.parse(event.body ?? '{}');
    } catch {
      throw httpError(400, 'validation.invalid_json', 'Invalid JSON body');
    }

    if (!body.dateRangeStart || !body.dateRangeEnd) {
      throw httpError(
        400,
        'validation.missing_fields',
        'dateRangeStart and dateRangeEnd are required',
      );
    }

    const result = await analyticsService.requestTrendReport(
      pathOrgId,
      orgId,
      role,
      memberId,
      sourceIp,
      body.dateRangeStart,
      body.dateRangeEnd,
    );

    if (result.async) {
      return ok({ jobId: result.jobId, status: 'queued' }, 202);
    }

    return ok({ report: result.report });
  }

  // GET /v1/orgs/{orgId}/analytics/trend-report/{reportId}
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/analytics\/trend-report\/[^/]+\/?$/.test(path)
  ) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const reportId = event.pathParameters?.['reportId'];

    if (!reportId) {
      throw httpError(400, 'validation.missing_param', 'reportId is required');
    }

    const result = await analyticsService.getTrendReportStatus(
      pathOrgId,
      reportId,
      orgId,
      role,
    );

    return ok({ report: result });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
