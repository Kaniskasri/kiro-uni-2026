import { OrgRole } from '../shared/layers/rbac';

// ─── Invitation types ─────────────────────────────────────────────────────────

export type InvitationStatus = 'Pending' | 'Accepted' | 'Expired';

export interface Invitation {
  invitationId: string;
  orgId: string;
  email: string;
  role: OrgRole;
  status: InvitationStatus;
  expiresAt: string; // UTC ISO 8601
  createdAt: string; // UTC ISO 8601
  tenantId: string; // equals orgId
}

export interface OrgMember {
  orgId: string;
  memberId: string;
  role: OrgRole;
  status: 'Active' | 'Removed';
  joinedAt: string; // UTC ISO 8601
  tenantId: string; // equals orgId
}

// ─── Request / Response types ─────────────────────────────────────────────────

export interface InviteRequest {
  email: string;
  role: OrgRole;
}

export interface BulkInviteRow {
  email: string;
  role: string;
}

export interface BulkInviteResult {
  accepted: Array<{ email: string; role: string }>;
  skipped: Array<{ email: string; role: string; reason: string }>;
  totalRows: number;
}

export interface ChangeRoleRequest {
  role: OrgRole;
}

export interface MembersListResponse {
  members: OrgMember[];
  nextToken?: string;
}

// ─── DynamoDB item shapes ─────────────────────────────────────────────────────

export interface InvitationDynamoItem {
  PK: string;           // ORG#{orgId}
  SK: string;           // INVITATION#{invitationId}
  GSI1PK: string;       // TOKEN#{tokenHash}
  GSI1SK: string;       // INVITATION
  GSI2PK: string;       // ORG#{orgId}#EMAIL#{email}
  GSI2SK: string;       // INVITATION
  type: 'INVITATION';
  invitationId: string;
  orgId: string;
  email: string;
  role: OrgRole;
  status: InvitationStatus;
  tokenHash: string;    // SHA-256 hash of the raw token
  expiresAt: string;    // UTC ISO 8601
  createdAt: string;    // UTC ISO 8601
  tenantId: string;     // equals orgId
}

export interface MembershipDynamoItem {
  PK: string;           // ORG#{orgId}
  SK: string;           // MEMBER#{memberId}
  GSI1PK: string;       // MEMBER#{memberId}
  GSI1SK: string;       // ORG#{orgId}
  type: 'ORG_MEMBERSHIP';
  orgId: string;
  memberId: string;
  role: OrgRole;
  status: 'Active' | 'Removed';
  tenantId: string;
  joinedAt: string;
  updatedAt?: string;
}
