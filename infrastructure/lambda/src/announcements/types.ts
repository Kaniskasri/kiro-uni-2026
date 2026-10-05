// ─── Announcement audience types ─────────────────────────────────────────────

export type AudienceType = 'AllMembers' | 'EventAttendees' | 'Role' | 'Manual';

export type OrgRole = 'Owner' | 'Admin' | 'Organizer' | 'Member';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface AnnouncementAudience {
  type: AudienceType;
  /** Required when type = 'EventAttendees' */
  eventId?: string;
  /** Required when type = 'Role' */
  role?: OrgRole;
  /** Required when type = 'Manual'; max 500 memberIds */
  memberIds?: string[];
}

export interface CreateAnnouncementRequest {
  subject: string;
  body: string;
  audience: AnnouncementAudience;
}

export interface Announcement {
  announcementId: string;
  orgId: string;
  subject: string;
  body: string;
  audience: AnnouncementAudience;
  /** Number of notification messages enqueued */
  recipientCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ─── DynamoDB item ────────────────────────────────────────────────────────────

export interface AnnouncementDynamoItem {
  PK: string;           // ORG#{orgId}
  SK: string;           // ANNOUNCEMENT#{announcementId}
  GSI2PK: string;       // ORG#{orgId}#ANNOUNCEMENTS
  GSI2SK: string;       // ANNOUNCEMENT#{createdAt}#{announcementId}
  type: 'ANNOUNCEMENT';
  announcementId: string;
  orgId: string;
  tenantId: string;
  subject: string;
  body: string;
  audience: AnnouncementAudience;
  recipientCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ─── OrgMembership item shape (partial, for resolution) ───────────────────────

export interface OrgMembershipItem {
  PK: string;
  SK: string;
  memberId: string;
  orgId: string;
  role: OrgRole;
  tenantId: string;
}
