import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { validatePayload } from '../shared/middleware/validatePayload';
import * as checkInService from './service';

// ─── JSON Schemas ──────────────────────────────────────────────────────────────

const SCHEMAS = {
  checkIn: {
    type: 'object',
    required: ['ticketCode'],
    properties: {
      ticketCode: { type: 'string', minLength: 1 },
      attendeeName: { type: 'string', minLength: 1, maxLength: 200 },
    },
    additionalProperties: false,
  },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseBody(event: APIGatewayProxyEvent): unknown {
  if (!event.body) {
    throw httpError(400, 'validation.missing_body', 'Request body is required');
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw httpError(400, 'validation.invalid_json', 'Invalid JSON in request body');
  }
}

function ok(body: unknown, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Extracts authorizer context injected by the Lambda Authorizer.
 * orgId / tenantId ALWAYS come from the JWT claim — never from the request body.
 */
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

  const sourceIp = event.requestContext?.identity?.sourceIp ?? '0.0.0.0';

  return { orgId, memberId, role, sourceIp };
}

// ─── Route handler ─────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // ── POST /v1/orgs/{orgId}/events/{eventId}/checkins ───────────────────────
  if (
    method === 'POST' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/checkins\/?$/.test(path)
  ) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const body = validatePayload<{ ticketCode: string; attendeeName?: string }>(
      SCHEMAS.checkIn,
      parseBody(event),
      'checkIn',
    );

    const result = await checkInService.checkIn(
      pathOrgId,
      eventId,
      orgId,
      memberId,
      role,
      sourceIp,
      { ticketCode: body.ticketCode, attendeeName: body.attendeeName },
    );

    return ok({ checkIn: result });
  }

  // ── GET /v1/orgs/{orgId}/events/{eventId}/checkins/stats ──────────────────
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/checkins\/stats\/?$/.test(path)
  ) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const result = await checkInService.getCheckInStats(
      pathOrgId,
      eventId,
      orgId,
      role,
    );

    return ok({ stats: result });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
