import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import * as dataPrivacyService from './service';

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

  if (!memberId) {
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

  // POST /v1/me/data-export
  if (method === 'POST' && /^\/v1\/me\/data-export\/?$/.test(path)) {
    const { memberId, sourceIp } = getAuthContext(event);

    const result = await dataPrivacyService.requestDataExport(memberId, memberId, sourceIp);
    return ok({ presignedUrl: result.presignedUrl }, 202);
  }

  // DELETE /v1/me/account
  if (method === 'DELETE' && /^\/v1\/me\/account\/?$/.test(path)) {
    const { memberId, sourceIp } = getAuthContext(event);

    await dataPrivacyService.deleteAccount(memberId, memberId, sourceIp);
    return { statusCode: 204, headers: {}, body: '' };
  }

  // GET /v1/orgs/{orgId}/admin/member-data-map
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/admin\/member-data-map\/?$/.test(path)
  ) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const targetMemberId = event.queryStringParameters?.['memberId'];

    if (!targetMemberId) {
      throw httpError(400, 'validation.missing_param', 'memberId query parameter is required');
    }

    const result = await dataPrivacyService.getMemberDataMap(
      pathOrgId,
      orgId,
      role,
      targetMemberId,
    );

    return ok({ dataMap: result });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
