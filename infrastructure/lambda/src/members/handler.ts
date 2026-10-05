import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { validatePayload } from '../shared/middleware/validatePayload';
import * as memberService from './service';

// ─── JSON Schemas ─────────────────────────────────────────────────────────────

const SCHEMAS = {
  invite: {
    type: 'object',
    required: ['email', 'role'],
    properties: {
      email: { type: 'string', minLength: 3, maxLength: 254 },
      role: { type: 'string', enum: ['Admin', 'Organizer', 'Member'] },
    },
    additionalProperties: false,
  },
  changeRole: {
    type: 'object',
    required: ['role'],
    properties: {
      role: { type: 'string', enum: ['Owner', 'Admin', 'Organizer', 'Member'] },
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

function noContent(): APIGatewayProxyResult {
  return { statusCode: 204, headers: {}, body: '' };
}

/**
 * Extracts authorizer context values set by the Lambda Authorizer.
 * orgId / tenantId ALWAYS come from the verified JWT claim — never from request body.
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

/**
 * Parses a multiline CSV body (RFC 4180) into rows of { email, role }.
 * First line is treated as header if it contains "email" (case-insensitive).
 */
function parseCsvBody(rawBody: string): Array<{ email: string; role: string }> {
  const lines = rawBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return [];

  // Detect header row
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('email');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map((line) => {
    // Handle quoted CSV fields
    const cols = line.split(',').map((c) => c.replace(/^"|"$/g, '').trim());
    return { email: cols[0] ?? '', role: cols[1] ?? '' };
  });
}

// ─── Route handler ────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // ── POST /v1/orgs/{orgId}/invitations ─────────────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/invitations\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const body = validatePayload<{ email: string; role: string }>(
      SCHEMAS.invite,
      parseBody(event),
      'invite',
    );

    const invitation = await memberService.inviteMember(
      pathOrgId,
      orgId, // tenantId from JWT — never from path
      role,
      memberId,
      sourceIp,
      body.email,
      body.role,
    );

    return ok({ invitation }, 201);
  }

  // ── POST /v1/orgs/{orgId}/invitations/bulk ────────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/invitations\/bulk\/?$/.test(path)) {
    const { orgId, memberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    if (!event.body) {
      throw httpError(400, 'validation.missing_body', 'CSV body is required');
    }

    const rows = parseCsvBody(event.body);
    const result = await memberService.bulkInviteMembers(
      pathOrgId,
      orgId, // tenantId from JWT
      role,
      memberId,
      sourceIp,
      rows,
    );

    return ok({ result }, 200);
  }

  // ── GET /v1/orgs/{orgId}/invitations/{token}/accept (PUBLIC endpoint) ─────
  // This is a public endpoint — no JWT required. The token IS the auth mechanism.
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/invitations\/[^/]+\/accept\/?$/.test(path)) {
    // For this public endpoint, memberId may come from a query param or header
    // (in practice, the frontend sends it after the user is logged in/registered)
    const rawToken = event.pathParameters?.['invitationId'] ?? '';
    if (!rawToken) {
      throw httpError(400, 'validation.missing_token', 'Invitation token is required');
    }

    // The accepting member must be authenticated — extract from authorizer if present,
    // or from query string parameter for the initial accept flow
    const ctx = event.requestContext?.authorizer as
      | { memberId?: string }
      | undefined;
    const acceptingMemberId =
      ctx?.memberId ?? event.queryStringParameters?.['memberId'] ?? '';

    if (!acceptingMemberId) {
      throw httpError(
        401,
        'auth.unauthorized',
        'You must be logged in to accept an invitation',
      );
    }

    const sourceIp = event.requestContext?.identity?.sourceIp ?? '0.0.0.0';

    const result = await memberService.acceptInvitation(rawToken, acceptingMemberId, sourceIp);

    return ok({
      message: 'Invitation accepted. You are now a member of the organization.',
      orgId: result.orgId,
      role: result.role,
    });
  }

  // ── GET /v1/orgs/{orgId}/members ──────────────────────────────────────────
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/members\/?$/.test(path)) {
    const { orgId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    const limitParam = event.queryStringParameters?.['limit'];
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 20, 100) : 20;
    const nextToken = event.queryStringParameters?.['nextToken'];

    const result = await memberService.listMembers(
      pathOrgId,
      orgId, // tenantId from JWT
      role,
      limit,
      nextToken,
    );

    return ok(result);
  }

  // ── PUT /v1/orgs/{orgId}/members/{memberId}/role ──────────────────────────
  if (method === 'PUT' && /^\/v1\/orgs\/[^/]+\/members\/[^/]+\/role\/?$/.test(path)) {
    const { orgId, memberId: callerMemberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const targetMemberId = event.pathParameters?.['memberId'] ?? '';

    if (!targetMemberId) {
      throw httpError(400, 'validation.missing_param', 'memberId path parameter is required');
    }

    const body = validatePayload<{ role: string }>(
      SCHEMAS.changeRole,
      parseBody(event),
      'changeRole',
    );

    const member = await memberService.changeMemberRole(
      pathOrgId,
      orgId, // tenantId from JWT
      role,
      callerMemberId,
      targetMemberId,
      body.role,
      sourceIp,
    );

    return ok({ member });
  }

  // ── DELETE /v1/orgs/{orgId}/members/{memberId} ────────────────────────────
  if (method === 'DELETE' && /^\/v1\/orgs\/[^/]+\/members\/[^/]+\/?$/.test(path)) {
    const { orgId, memberId: callerMemberId, role, sourceIp } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;
    const targetMemberId = event.pathParameters?.['memberId'] ?? '';

    if (!targetMemberId) {
      throw httpError(400, 'validation.missing_param', 'memberId path parameter is required');
    }

    await memberService.removeMember(
      pathOrgId,
      orgId, // tenantId from JWT
      role,
      callerMemberId,
      targetMemberId,
      sourceIp,
    );

    return noContent();
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
