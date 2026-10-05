import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { validatePayload } from '../shared/middleware/validatePayload';
import * as orgService from './service';

// ─── JSON Schemas ─────────────────────────────────────────────────────────────

const SCHEMAS = {
  createOrg: {
    type: 'object',
    required: ['name', 'slug'],
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 100 },
      slug: {
        type: 'string',
        minLength: 3,
        maxLength: 63,
        pattern: '^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$',
      },
      settings: { type: 'object' },
    },
    additionalProperties: false,
  },
  updateOrg: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 3, maxLength: 100 },
      settings: { type: 'object' },
    },
    additionalProperties: false,
    minProperties: 1,
  },
  transferOwnership: {
    type: 'object',
    required: ['targetMemberId'],
    properties: {
      targetMemberId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
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

// ─── Route handler ────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // ── POST /v1/orgs ──────────────────────────────────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/?$/.test(path)) {
    // Note: POST /v1/orgs creates a new org — the caller becomes the Owner.
    // memberId comes from the JWT; no orgId from path for this route.
    const ctx = event.requestContext?.authorizer as
      | { memberId?: string }
      | undefined;
    const memberId = ctx?.memberId ?? '';
    if (!memberId) {
      throw httpError(401, 'auth.unauthorized', 'Missing authorization context');
    }

    const body = validatePayload<{
      name: string;
      slug: string;
      settings?: Record<string, unknown>;
    }>(SCHEMAS.createOrg, parseBody(event), 'createOrg');

    const result = await orgService.createOrg(
      memberId,
      body.name,
      body.slug,
      body.settings ?? {},
    );

    return ok({ org: result.org, membership: result.membership }, 201);
  }

  // ── GET /v1/orgs/{orgId} ───────────────────────────────────────────────────
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/?$/.test(path)) {
    const { orgId, memberId: _memberId } = getAuthContext(event);
    // Path parameter for key construction only
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const org = await orgService.getOrg(pathOrgId, orgId);
    return ok({ org });
  }

  // ── PUT /v1/orgs/{orgId} ───────────────────────────────────────────────────
  if (method === 'PUT' && /^\/v1\/orgs\/[^/]+\/?$/.test(path)) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const body = validatePayload<{
      name?: string;
      settings?: Record<string, unknown>;
    }>(SCHEMAS.updateOrg, parseBody(event), 'updateOrg');

    const org = await orgService.updateOrg(pathOrgId, orgId, role, body);
    return ok({ org });
  }

  // ── POST /v1/orgs/{orgId}/deactivate ──────────────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/deactivate\/?$/.test(path)) {
    const { orgId, role, memberId, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    await orgService.deactivateOrg(pathOrgId, orgId, role, sourceIp, memberId);
    return ok({ message: 'Organization deactivated.' });
  }

  // ── POST /v1/orgs/{orgId}/transfer-ownership ───────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/transfer-ownership\/?$/.test(path)) {
    const { orgId, role, memberId, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const body = validatePayload<{ targetMemberId: string }>(
      SCHEMAS.transferOwnership,
      parseBody(event),
      'transferOwnership',
    );

    await orgService.transferOwnership(
      pathOrgId,
      orgId,
      role,
      memberId,
      body.targetMemberId,
      sourceIp,
    );

    return ok({ message: 'Ownership transferred successfully.' });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
