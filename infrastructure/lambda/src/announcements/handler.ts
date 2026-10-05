import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { createAnnouncement, listAnnouncements } from './service';
import { CreateAnnouncementRequest, AnnouncementAudience, AudienceType, OrgRole } from './types';

// ─── Helpers ───────────────────────────────────────────────────────────────────

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

  return { orgId, memberId, role };
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

const VALID_AUDIENCE_TYPES: AudienceType[] = ['AllMembers', 'EventAttendees', 'Role', 'Manual'];
const VALID_ROLES: OrgRole[] = ['Owner', 'Admin', 'Organizer', 'Member'];

function validateAudience(raw: unknown): AnnouncementAudience {
  if (!raw || typeof raw !== 'object') {
    throw httpError(400, 'announcement.invalid_audience', 'audience must be an object');
  }
  const a = raw as Record<string, unknown>;

  if (!VALID_AUDIENCE_TYPES.includes(a['type'] as AudienceType)) {
    throw httpError(
      400,
      'announcement.invalid_audience_type',
      `audience.type must be one of: ${VALID_AUDIENCE_TYPES.join(', ')}`,
    );
  }

  const type = a['type'] as AudienceType;

  if (type === 'EventAttendees' && (!a['eventId'] || typeof a['eventId'] !== 'string')) {
    throw httpError(400, 'announcement.missing_event_id', 'audience.eventId is required for EventAttendees');
  }

  if (type === 'Role') {
    if (!VALID_ROLES.includes(a['role'] as OrgRole)) {
      throw httpError(
        400,
        'announcement.invalid_role',
        `audience.role must be one of: ${VALID_ROLES.join(', ')}`,
      );
    }
  }

  if (type === 'Manual') {
    if (!Array.isArray(a['memberIds']) || a['memberIds'].length === 0) {
      throw httpError(400, 'announcement.missing_member_ids', 'audience.memberIds must be a non-empty array');
    }
    if ((a['memberIds'] as unknown[]).length > 500) {
      throw httpError(400, 'announcement.audience_too_large', 'Manual audience cannot exceed 500 members');
    }
    for (const id of a['memberIds'] as unknown[]) {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw httpError(400, 'announcement.invalid_member_id', 'Each memberId must be a non-empty string');
      }
    }
  }

  return {
    type,
    eventId: type === 'EventAttendees' ? (a['eventId'] as string) : undefined,
    role: type === 'Role' ? (a['role'] as OrgRole) : undefined,
    memberIds: type === 'Manual' ? (a['memberIds'] as string[]) : undefined,
  };
}

// ─── RBAC guard ────────────────────────────────────────────────────────────────

function requireOrganizerOrAbove(role: string): void {
  const allowed = ['Owner', 'Admin', 'Organizer'];
  if (!allowed.includes(role)) {
    throw httpError(403, 'auth.forbidden', 'Organizer role or above is required');
  }
}

// ─── Route handler ─────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // ── POST /v1/orgs/{orgId}/announcements ───────────────────────────────────
  if (method === 'POST' && /^\/v1\/orgs\/[^/]+\/announcements\/?$/.test(path)) {
    const { orgId, memberId, role } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    // Tenant isolation
    if (orgId !== pathOrgId) {
      throw httpError(403, 'auth.forbidden', 'Cross-org access denied');
    }

    requireOrganizerOrAbove(role);

    const rawBody = parseBody(event) as Record<string, unknown>;

    const subject = rawBody['subject'];
    const body = rawBody['body'];
    const rawAudience = rawBody['audience'];

    if (typeof subject !== 'string' || subject.trim().length === 0) {
      throw httpError(400, 'validation.invalid_field', 'subject is required');
    }
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw httpError(400, 'validation.invalid_field', 'body is required');
    }

    const audience = validateAudience(rawAudience);

    const req: CreateAnnouncementRequest = {
      subject: subject.trim(),
      body: body.trim(),
      audience,
    };

    const announcement = await createAnnouncement(orgId, orgId, memberId, req);

    return ok({ announcement }, 201);
  }

  // ── GET /v1/orgs/{orgId}/announcements ────────────────────────────────────
  if (method === 'GET' && /^\/v1\/orgs\/[^/]+\/announcements\/?$/.test(path)) {
    const { orgId } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    if (orgId !== pathOrgId) {
      throw httpError(403, 'auth.forbidden', 'Cross-org access denied');
    }

    const { limit, nextToken } = parsePaginationParams(event);
    const result = await listAnnouncements(orgId, orgId, limit, nextToken);

    return ok({ announcements: result.announcements, nextToken: result.nextToken });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
