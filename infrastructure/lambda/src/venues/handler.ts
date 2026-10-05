import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { validatePayload } from '../shared/middleware/validatePayload';
import * as venueService from './service';

// ─── JSON Schemas ─────────────────────────────────────────────────────────────

const SCHEMAS = {
  createVenue: {
    type: 'object',
    required: ['name', 'address', 'capacity'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      address: { type: 'string', minLength: 1, maxLength: 500 },
      capacity: { type: 'integer', minimum: 1, maximum: 999999 },
      amenities: {
        type: 'array',
        maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    additionalProperties: false,
  },
  updateVenue: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      address: { type: 'string', minLength: 1, maxLength: 500 },
      capacity: { type: 'integer', minimum: 1, maximum: 999999 },
      amenities: {
        type: 'array',
        maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 100 },
      },
    },
    additionalProperties: false,
    minProperties: 1,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function getPaginationParams(event: APIGatewayProxyEvent): { limit: number; nextToken?: string } {
  const limitStr = event.queryStringParameters?.['limit'];
  const nextToken = event.queryStringParameters?.['nextToken'] ?? undefined;
  const limit = limitStr ? Math.min(parseInt(limitStr, 10) || 20, 100) : 20;
  return { limit, nextToken };
}

// ─── Route handler ────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // ── POST /v1/orgs/{orgId}/venues ───────────────────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/venues\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    // Path parameter used only for DynamoDB key construction
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const body = validatePayload<{
      name: string;
      address: string;
      capacity: number;
      amenities?: string[];
    }>(SCHEMAS.createVenue, parseBody(event), 'createVenue');

    const venue = await venueService.createVenue(
      pathOrgId,
      orgId,
      role,
      memberId,
      sourceIp,
      body,
    );

    return ok({ venue }, 201);
  }

  // ── GET /v1/orgs/{orgId}/venues ────────────────────────────────────────────
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/venues\/?$/.test(path)) {
    const { orgId } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const { limit, nextToken } = getPaginationParams(event);

    const result = await venueService.listVenues(pathOrgId, orgId, limit, nextToken);
    return ok(result);
  }

  // ── GET /v1/orgs/{orgId}/venues/{venueId} ──────────────────────────────────
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/venues\/[^/]+\/?$/.test(path)) {
    const { orgId } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const venueId = event.pathParameters?.['venueId'];

    if (!venueId) {
      throw httpError(400, 'validation.missing_param', 'venueId path parameter is required');
    }

    const venue = await venueService.getVenue(pathOrgId, venueId, orgId);
    return ok({ venue });
  }

  // ── PUT /v1/orgs/{orgId}/venues/{venueId} ──────────────────────────────────
  if (method === 'PUT' && /^\/v1\/orgs\/[^/]+\/venues\/[^/]+\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const venueId = event.pathParameters?.['venueId'];

    if (!venueId) {
      throw httpError(400, 'validation.missing_param', 'venueId path parameter is required');
    }

    const body = validatePayload<{
      name?: string;
      address?: string;
      capacity?: number;
      amenities?: string[];
    }>(SCHEMAS.updateVenue, parseBody(event), 'updateVenue');

    const venue = await venueService.updateVenue(
      pathOrgId,
      venueId,
      orgId,
      role,
      memberId,
      sourceIp,
      body,
    );

    return ok({ venue });
  }

  // ── DELETE /v1/orgs/{orgId}/venues/{venueId} ───────────────────────────────
  if (method === 'DELETE' && /^\/v1\/orgs\/[^/]+\/venues\/[^/]+\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const venueId = event.pathParameters?.['venueId'];

    if (!venueId) {
      throw httpError(400, 'validation.missing_param', 'venueId path parameter is required');
    }

    try {
      await venueService.deleteVenue(
        pathOrgId,
        venueId,
        orgId,
        role,
        memberId,
        sourceIp,
      );
    } catch (err) {
      // Re-throw with blockingEvents in the response body if present
      const error = err as Error & { statusCode?: number; errorCode?: string; blockingEvents?: unknown[] };
      if (error.statusCode === 409 && error.blockingEvents) {
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            errorCode: error.errorCode ?? 'venue.has_active_events',
            message: (error.message ?? 'Venue deletion blocked').slice(0, 500),
            blockingEvents: error.blockingEvents,
          }),
        };
      }
      throw err;
    }

    return { statusCode: 204, headers: { 'Content-Type': 'application/json' }, body: '' };
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
