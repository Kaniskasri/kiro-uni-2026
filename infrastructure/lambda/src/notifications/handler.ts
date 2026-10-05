import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import * as repo from './repository';

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

// ─── Route handler ─────────────────────────────────────────────────────────────

const rawHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod;
  const path = event.path;

  // ── GET /v1/me/notifications ──────────────────────────────────────────────
  if (method === 'GET' && /^\/v1\/me\/notifications\/?$/.test(path)) {
    const { orgId, memberId } = getAuthContext(event);
    const { limit, nextToken } = parsePaginationParams(event);

    const result = await repo.listNotificationsForMember(memberId, orgId, limit, nextToken);

    return ok({
      notifications: result.notifications.map((n) => ({
        notificationId: n.notificationId,
        orgId: n.orgId,
        memberId: n.memberId,
        notificationType: n.notificationType,
        subject: n.subject,
        inAppMessage: n.inAppMessage,
        deliveryStatus: n.deliveryStatus,
        read: n.read,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        metadata: n.metadata,
      })),
      nextToken: result.nextToken,
    });
  }

  // ── PUT /v1/me/notifications/{notificationId}/read ────────────────────────
  if (
    method === 'PUT' &&
    /^\/v1\/me\/notifications\/[^/]+\/read\/?$/.test(path)
  ) {
    const { orgId, memberId } = getAuthContext(event);
    const notificationId = event.pathParameters?.['notificationId'];

    if (!notificationId) {
      throw httpError(400, 'validation.missing_param', 'notificationId path parameter is required');
    }

    const updated = await repo.markNotificationRead(memberId, notificationId, orgId);
    if (!updated) {
      throw httpError(404, 'notification.not_found', 'Notification not found');
    }

    return ok({
      notificationId: updated.notificationId,
      read: updated.read,
      updatedAt: updated.updatedAt,
    });
  }

  // ── PUT /v1/orgs/{orgId}/notifications/opt-out ────────────────────────────
  if (
    method === 'PUT' &&
    /^\/v1\/orgs\/[^/]+\/notifications\/opt-out\/?$/.test(path)
  ) {
    const { orgId, memberId } = getAuthContext(event);
    const pathOrgId = event.pathParameters?.['orgId'] ?? orgId;

    // Tenant isolation: authenticated orgId must match path orgId
    if (orgId !== pathOrgId) {
      throw httpError(403, 'auth.forbidden', 'Cross-org access denied');
    }

    const body = parseBody(event) as Record<string, unknown>;
    const optedOut = body['optedOut'];

    if (typeof optedOut !== 'boolean') {
      throw httpError(400, 'validation.invalid_field', 'optedOut must be a boolean');
    }

    await repo.setEmailOptOut(memberId, orgId, optedOut);

    return ok({ memberId, orgId, optedOut });
  }

  throw httpError(404, 'http.not_found', 'Route not found');
};

export const handler = errorMiddleware(rawHandler);
