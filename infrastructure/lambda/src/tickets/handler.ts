import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { validatePayload } from '../shared/middleware/validatePayload';
import * as ticketService from './service';

// ─── JSON Schemas ──────────────────────────────────────────────────────────────

const SCHEMAS = {
  createTicket: {
    type: 'object',
    properties: {
      memberId: { type: 'string', minLength: 1 },
      guestEmail: { type: 'string', minLength: 5, maxLength: 254 },
      guestName: { type: 'string', minLength: 1, maxLength: 200 },
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

function parsePaginationParams(event: APIGatewayProxyEvent): {
  limit: number;
  nextToken: string | undefined;
} {
  const qs = event.queryStringParameters ?? {};
  const rawLimit = qs['limit'] ? parseInt(qs['limit'], 10) : 20;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, 100);
  const nextToken = qs['nextToken'] ?? undefined;
  return { limit, nextToken };
}

// ─── Route handler ─────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // ── POST /v1/orgs/{orgId}/events/{eventId}/tickets ────────────────────────
  if (
    method === 'POST' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/tickets\/?$/.test(path)
  ) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const body = validatePayload<{
      memberId?: string;
      guestEmail?: string;
      guestName?: string;
    }>(SCHEMAS.createTicket, parseBody(event), 'createTicket');

    // Default to the authenticated member if neither memberId nor guestEmail provided
    const effectiveMemberId = body.memberId ?? (body.guestEmail ? undefined : memberId);

    const result = await ticketService.createTicket(
      pathOrgId,
      eventId,
      orgId,
      memberId,
      sourceIp,
      {
        memberId: effectiveMemberId,
        guestEmail: body.guestEmail,
        guestName: body.guestName,
      },
    );

    return ok({ ticket: result }, 201);
  }

  // ── GET /v1/orgs/{orgId}/events/{eventId}/tickets ─────────────────────────
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/tickets\/?$/.test(path)
  ) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const { limit, nextToken } = parsePaginationParams(event);
    const result = await ticketService.listTickets(
      pathOrgId,
      eventId,
      orgId,
      role,
      limit,
      nextToken,
    );

    return ok({ tickets: result.tickets, nextToken: result.nextToken });
  }

  // ── GET /v1/orgs/{orgId}/events/{eventId}/waitlist ────────────────────────
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/waitlist\/?$/.test(path)
  ) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const { limit, nextToken } = parsePaginationParams(event);
    const result = await ticketService.listWaitlist(
      pathOrgId,
      eventId,
      orgId,
      role,
      limit,
      nextToken,
    );

    return ok({ tickets: result.tickets, nextToken: result.nextToken });
  }

  // ── GET /v1/orgs/{orgId}/events/{eventId}/tickets/{ticketId} ─────────────
  if (
    method === 'GET' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/tickets\/[^/]+\/?$/.test(path)
  ) {
    const { orgId, memberId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];
    const ticketId = event.pathParameters?.['ticketId'];

    if (!eventId || !ticketId) {
      throw httpError(
        400,
        'validation.missing_param',
        'eventId and ticketId path parameters are required',
      );
    }

    const result = await ticketService.getTicket(
      pathOrgId,
      eventId,
      ticketId,
      orgId,
      memberId,
      role,
    );

    return ok({ ticket: result });
  }

  // ── DELETE /v1/orgs/{orgId}/events/{eventId}/tickets/{ticketId} ──────────
  if (
    method === 'DELETE' &&
    /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/tickets\/[^/]+\/?$/.test(path)
  ) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];
    const ticketId = event.pathParameters?.['ticketId'];

    if (!eventId || !ticketId) {
      throw httpError(
        400,
        'validation.missing_param',
        'eventId and ticketId path parameters are required',
      );
    }

    await ticketService.cancelTicket(
      pathOrgId,
      eventId,
      ticketId,
      orgId,
      memberId,
      role,
      sourceIp,
    );

    return { statusCode: 204, headers: { 'Content-Type': 'application/json' }, body: '' };
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
