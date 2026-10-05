import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { validatePayload } from '../shared/middleware/validatePayload';
import * as eventService from './service';
import { EventStatus } from './types';

// ─── JSON Schemas ──────────────────────────────────────────────────────────────

const SCHEMAS = {
  createEvent: {
    type: 'object',
    required: ['title', 'startAt', 'endAt', 'timezone', 'capacity'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 5000 },
      startAt: { type: 'string' },
      endAt: { type: 'string' },
      timezone: { type: 'string' },
      capacity: { type: 'integer', minimum: 1, maximum: 100000 },
      venueId: { type: 'string', minLength: 1 },
      address: { type: 'string', minLength: 1, maxLength: 500 },
      meetingUrl: { type: 'string', minLength: 1, maxLength: 2048 },
      isVirtual: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  updateEvent: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      description: { type: 'string', maxLength: 5000 },
      startAt: { type: 'string' },
      endAt: { type: 'string' },
      timezone: { type: 'string' },
      capacity: { type: 'integer', minimum: 1, maximum: 100000 },
      venueId: { type: 'string', minLength: 1 },
      address: { type: 'string', minLength: 1, maxLength: 500 },
      meetingUrl: { type: 'string', minLength: 1, maxLength: 2048 },
      isVirtual: { type: 'boolean' },
    },
    additionalProperties: false,
    minProperties: 1,
  },
  transition: {
    type: 'object',
    required: ['status'],
    properties: {
      status: {
        type: 'string',
        enum: ['Draft', 'Published', 'Open', 'In_Progress', 'Completed', 'Archived', 'Cancelled'],
      },
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
 * Extracts authorizer context values injected by the Lambda Authorizer.
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

  // ── POST /v1/orgs/{orgId}/events ───────────────────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/events\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const body = validatePayload<{
      title: string;
      description?: string;
      startAt: string;
      endAt: string;
      timezone: string;
      capacity: number;
      venueId?: string;
      address?: string;
      meetingUrl?: string;
      isVirtual?: boolean;
    }>(SCHEMAS.createEvent, parseBody(event), 'createEvent');

    const result = await eventService.createEvent(
      pathOrgId,
      orgId,
      role,
      memberId,
      sourceIp,
      body,
    );

    return ok({ event: result }, 201);
  }

  // ── GET /v1/orgs/{orgId}/events ────────────────────────────────────────────
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/events\/?$/.test(path)) {
    const { orgId } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const { limit, nextToken } = parsePaginationParams(event);

    const rawStatus = event.queryStringParameters?.['status'];
    const validStatuses: EventStatus[] = [
      'Draft',
      'Published',
      'Open',
      'In_Progress',
      'Completed',
      'Archived',
      'Cancelled',
    ];
    let status: EventStatus | undefined;
    if (rawStatus) {
      if (!validStatuses.includes(rawStatus as EventStatus)) {
        throw httpError(
          400,
          'validation.invalid_status',
          `Invalid status filter. Valid values: ${validStatuses.join(', ')}`,
        );
      }
      status = rawStatus as EventStatus;
    }

    const result = await eventService.listEvents(pathOrgId, orgId, limit, status, nextToken);
    return ok({ events: result.events, nextToken: result.nextToken });
  }

  // ── GET /v1/orgs/{orgId}/events/{eventId} ──────────────────────────────────
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/?$/.test(path)) {
    const { orgId } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const result = await eventService.getEvent(pathOrgId, eventId, orgId);
    return ok({ event: result });
  }

  // ── PUT /v1/orgs/{orgId}/events/{eventId} ──────────────────────────────────
  if (method === 'PUT' && /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const body = validatePayload<{
      title?: string;
      description?: string;
      startAt?: string;
      endAt?: string;
      timezone?: string;
      capacity?: number;
      venueId?: string;
      address?: string;
      meetingUrl?: string;
      isVirtual?: boolean;
    }>(SCHEMAS.updateEvent, parseBody(event), 'updateEvent');

    const result = await eventService.updateEvent(
      pathOrgId,
      eventId,
      orgId,
      role,
      memberId,
      sourceIp,
      body,
    );

    return ok({ event: result });
  }

  // ── POST /v1/orgs/{orgId}/events/{eventId}/publish ─────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/publish\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const result = await eventService.publishEvent(
      pathOrgId,
      eventId,
      orgId,
      role,
      memberId,
      sourceIp,
    );

    return ok({ event: result });
  }

  // ── POST /v1/orgs/{orgId}/events/{eventId}/cancel ──────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/cancel\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const result = await eventService.cancelEvent(
      pathOrgId,
      eventId,
      orgId,
      role,
      memberId,
      sourceIp,
    );

    return ok({ event: result });
  }

  // ── POST /v1/orgs/{orgId}/events/{eventId}/transition ─────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/events\/[^/]+\/transition\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const eventId = event.pathParameters?.['eventId'];

    if (!eventId) {
      throw httpError(400, 'validation.missing_param', 'eventId path parameter is required');
    }

    const body = validatePayload<{ status: EventStatus }>(
      SCHEMAS.transition,
      parseBody(event),
      'transition',
    );

    const result = await eventService.transitionEvent(
      pathOrgId,
      eventId,
      orgId,
      role,
      memberId,
      sourceIp,
      body.status,
    );

    return ok({ event: result });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
