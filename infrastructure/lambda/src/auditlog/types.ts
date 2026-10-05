// ─── Audit Log domain types ───────────────────────────────────────────────────

export interface AuditLogFilter {
  dateFrom?: string;   // UTC ISO 8601 — inclusive start
  dateTo?: string;     // UTC ISO 8601 — inclusive end
  actor?: string;      // memberId or "system"
  operation?: string;  // e.g., "org.deactivate"
  nextToken?: string;  // base64-encoded LastEvaluatedKey for pagination
  limit?: number;      // max 100, default 20
}

export interface AuditLogItem {
  PK: string;
  SK: string;
  type: 'AUDIT_LOG';
  tenantId: string;
  timestamp: string;       // UTC ISO 8601
  actor: string;           // memberId or "system"
  targetType: string;
  targetId: string;
  operation: string;
  sourceIp: string;
  outcome: 'success' | 'failure';
  orgId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogPageResult {
  items: AuditLogItem[];
  nextToken?: string;
}
