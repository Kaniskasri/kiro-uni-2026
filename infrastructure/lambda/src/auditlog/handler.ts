import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorMiddleware, httpError } from '../shared/middleware/errorMiddleware';
import { assertPermission } from '../shared/layers/rbac';
import { queryAuditLog } from './repository';
import { AuditLogFilter } from './types';

/**
 * AuditLogFn — GET /v1/orgs/{orgId}/audit-log
 *
 * Returns a paginated list of audit log entries for the organisation.
 * Requires Admin role or above.
 * Query params: dateFrom, dateTo, actor, operation, nextToken, limit
 */
export const handler = errorMiddleware(
  async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const correlationId =
      event.headers?.['x-correlation-id'] ??
      event.requestContext?.requestId ??
      'req-' + Date.now();

    // 1. Extract tenantId from authorizer context (never from path/body/query)
    const { orgId, role } = (event.requestContext?.authorizer ?? {}) as {
      orgId?: string;
      role?: string;
      memberId?: string;
    };

    if (!orgId) {
      throw httpError(401, 'auth.missing_context', 'Missing authorizer context');
    }

    // 2. Verify the path orgId matches the JWT orgId (cross-org guard)
    const pathOrgId = event.pathParameters?.['orgId'];
    if (pathOrgId && pathOrgId !== orgId) {
      throw httpError(403, 'auth.cross_org', 'Cross-organisation access is not permitted');
    }

    // 3. RBAC — requires Admin+
    assertPermission(role ?? '', 'auditlog:view');

    // 4. Parse query string filters
    const qs = event.queryStringParameters ?? {};
    const limitRaw = parseInt(qs['limit'] ?? '20', 10);
    const filter: AuditLogFilter = {
      dateFrom: qs['dateFrom'] ?? undefined,
      dateTo: qs['dateTo'] ?? undefined,
      actor: qs['actor'] ?? undefined,
      operation: qs['operation'] ?? undefined,
      nextToken: qs['nextToken'] ?? undefined,
      limit: isNaN(limitRaw) ? 20 : Math.min(Math.max(1, limitRaw), 100),
    };

    // 5. Query audit log (org-scoped, tenantId condition in repository)
    const result = await queryAuditLog(orgId, filter);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': correlationId,
      },
      body: JSON.stringify({
        items: result.items,
        nextToken: result.nextToken,
        count: result.items.length,
      }),
    };
  },
);
