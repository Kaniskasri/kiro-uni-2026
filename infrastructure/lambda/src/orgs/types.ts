import { OrgRole } from '../shared/layers/rbac';

// ─── Domain types ────────────────────────────────────────────────────────────

export type OrgStatus = 'Active' | 'Deactivated';

export interface Organization {
  orgId: string;
  name: string;
  slug: string;
  status: OrgStatus;
  settings: OrgSettings;
  createdAt: string; // UTC ISO 8601
  updatedAt: string; // UTC ISO 8601
  tenantId: string; // equals orgId
}

export interface OrgSettings {
  timezone?: string; // IANA timezone identifier
  [key: string]: unknown;
}

export interface OrgMembership {
  orgId: string;
  memberId: string;
  role: OrgRole;
  joinedAt: string; // UTC ISO 8601
  tenantId: string; // equals orgId
}

// ─── Request / Response types ─────────────────────────────────────────────────

export interface CreateOrgRequest {
  name: string;
  slug: string;
  settings?: OrgSettings;
}

export interface UpdateOrgRequest {
  name?: string;
  settings?: OrgSettings;
}

export interface TransferOwnershipRequest {
  targetMemberId: string;
}

// ─── DynamoDB item shapes ─────────────────────────────────────────────────────

export interface OrgDynamoItem {
  PK: string; // ORG#{orgId}
  SK: string; // METADATA
  GSI1PK: string; // SLUG#{slug}
  GSI1SK: string; // ORG#{orgId}
  type: 'ORGANIZATION';
  orgId: string;
  name: string;
  slug: string;
  status: OrgStatus;
  settings: OrgSettings;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipDynamoItem {
  PK: string; // ORG#{orgId}
  SK: string; // MEMBER#{memberId}
  type: 'ORG_MEMBERSHIP';
  orgId: string;
  memberId: string;
  role: OrgRole;
  tenantId: string;
  joinedAt: string;
}
