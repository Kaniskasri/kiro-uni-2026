import { createHash, randomBytes } from 'crypto';
import { randomUUID } from 'crypto';
import * as repo from './repository';
import { assertPermission, OrgRole } from '../shared/layers/rbac';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import {
  Invitation,
  OrgMember,
  BulkInviteRow,
  BulkInviteResult,
  InvitationDynamoItem,
  MembershipDynamoItem,
} from './types';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
const NOTIFICATION_QUEUE_URL = process.env['NOTIFICATION_QUEUE_URL'] ?? '';

// ─── Constants ────────────────────────────────────────────────────────────────

const INVITATION_TTL_HOURS = 72;
const VALID_INVITE_ROLES: OrgRole[] = ['Admin', 'Organizer', 'Member'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BULK_MAX_ROWS = 500;

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

function validateInviteRole(role: string): role is OrgRole {
  return VALID_INVITE_ROLES.includes(role as OrgRole);
}

// ─── Item mappers ─────────────────────────────────────────────────────────────

function toInvitation(item: InvitationDynamoItem): Invitation {
  return {
    invitationId: item.invitationId,
    orgId: item.orgId,
    email: item.email,
    role: item.role,
    status: item.status,
    expiresAt: item.expiresAt,
    createdAt: item.createdAt,
    tenantId: item.tenantId,
  };
}

function toMember(item: MembershipDynamoItem): OrgMember {
  return {
    orgId: item.orgId,
    memberId: item.memberId,
    role: item.role,
    status: item.status,
    joinedAt: item.joinedAt,
    tenantId: item.tenantId,
  };
}

// ─── Token generation ─────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random token and its SHA-256 hash.
 * The raw token is sent in the invitation link; only the hash is stored.
 */
function generateToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

// ─── SQS enqueue helpers ──────────────────────────────────────────────────────

/**
 * Enqueues an invitation email send to the notification SQS queue.
 * Actual SES dispatch is handled by the Worker Lambda.
 */
async function enqueueInvitationEmail(
  orgId: string,
  invitationId: string,
  email: string,
  role: OrgRole,
  rawToken: string,
  expiresAt: string,
): Promise<void> {
  if (!NOTIFICATION_QUEUE_URL) return; // Skip in test environments

  const message = {
    type: 'INVITATION_EMAIL',
    orgId,
    invitationId,
    email,
    role,
    acceptanceUrl: `/accept-invite/${rawToken}`,
    expiresAt,
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: NOTIFICATION_QUEUE_URL,
      MessageBody: JSON.stringify(message),
      MessageGroupId: orgId, // FIFO queue grouping by org
    }),
  );
}

// ─── Service operations ───────────────────────────────────────────────────────

/**
 * Sends a single invitation to an email address with a role.
 * - Validates email + role
 * - Checks for duplicate active membership or pending invitation
 * - Creates Invitation item with SHA-256 hashed token and 72h expiry
 * - Enqueues invitation email via SQS
 * - Writes audit log
 */
export async function inviteMember(
  orgId: string,
  tenantId: string,
  callerRole: string,
  callerMemberId: string,
  sourceIp: string,
  email: string,
  role: string,
): Promise<Invitation> {
  // tenantId must match orgId (JWT-derived isolation)
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'member.access_denied',
    });
  }

  assertPermission(callerRole, 'members:invite');

  // Validate inputs
  const normalizedEmail = email.toLowerCase().trim();
  if (!validateEmail(normalizedEmail)) {
    throw Object.assign(new Error('Invalid email address.'), {
      statusCode: 400,
      errorCode: 'member.invalid_email',
    });
  }

  if (!validateInviteRole(role)) {
    throw Object.assign(
      new Error(`Role must be one of: ${VALID_INVITE_ROLES.join(', ')}.`),
      { statusCode: 400, errorCode: 'member.invalid_role' },
    );
  }

  const inviteRole = role as OrgRole;

  // Duplicate active membership check
  const alreadyMember = await repo.activeMembershipExistsByEmail(orgId, normalizedEmail);
  if (alreadyMember) {
    throw Object.assign(
      new Error('This email address already belongs to an active member of this organization.'),
      { statusCode: 409, errorCode: 'member.already_member' },
    );
  }

  // Duplicate pending invitation check
  const alreadyInvited = await repo.activeMembershipOrInvitationExists(orgId, normalizedEmail);
  if (alreadyInvited) {
    throw Object.assign(
      new Error('A pending invitation already exists for this email address.'),
      { statusCode: 409, errorCode: 'invitation.already_pending' },
    );
  }

  const invitationId = randomUUID();
  const { rawToken, tokenHash } = generateToken();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_HOURS * 60 * 60 * 1000).toISOString();

  const item: InvitationDynamoItem = {
    PK: `ORG#${orgId}`,
    SK: `INVITATION#${invitationId}`,
    GSI1PK: `TOKEN#${tokenHash}`,
    GSI1SK: 'INVITATION',
    GSI2PK: `ORG#${orgId}#EMAIL#${normalizedEmail}`,
    GSI2SK: 'INVITATION',
    type: 'INVITATION',
    invitationId,
    orgId,
    email: normalizedEmail,
    role: inviteRole,
    status: 'Pending',
    tokenHash,
    expiresAt,
    createdAt,
    tenantId: orgId,
  };

  await repo.createInvitation(item);

  // Enqueue email dispatch via SQS (async — not on critical path)
  await enqueueInvitationEmail(orgId, invitationId, normalizedEmail, inviteRole, rawToken, expiresAt);

  // Audit log
  await writeAuditLog({
    timestamp: createdAt,
    actor: callerMemberId,
    targetType: 'INVITATION',
    targetId: invitationId,
    operation: 'member.invite',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return toInvitation(item);
}

/**
 * Bulk invite from a parsed CSV array.
 * - Rejects if > 500 rows
 * - Validates each row, skips invalid ones with reason
 * - Creates invitations for valid rows
 * - Returns summary report of accepted + skipped
 */
export async function bulkInviteMembers(
  orgId: string,
  tenantId: string,
  callerRole: string,
  callerMemberId: string,
  sourceIp: string,
  rows: BulkInviteRow[],
): Promise<BulkInviteResult> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'member.access_denied',
    });
  }

  assertPermission(callerRole, 'members:invite-bulk');

  if (rows.length > BULK_MAX_ROWS) {
    throw Object.assign(
      new Error(
        `CSV file exceeds the maximum allowed rows (${BULK_MAX_ROWS}). Please split the file.`,
      ),
      { statusCode: 400, errorCode: 'invitation.bulk_row_limit_exceeded' },
    );
  }

  const accepted: BulkInviteResult['accepted'] = [];
  const skipped: BulkInviteResult['skipped'] = [];

  for (const row of rows) {
    const normalizedEmail = (row.email ?? '').toLowerCase().trim();
    const role = (row.role ?? '').trim();

    // Validate email
    if (!validateEmail(normalizedEmail)) {
      skipped.push({ email: row.email, role: row.role, reason: 'invalid_email' });
      continue;
    }

    // Validate role
    if (!validateInviteRole(role)) {
      skipped.push({ email: normalizedEmail, role: row.role, reason: 'unrecognized_role' });
      continue;
    }

    // Check duplicate membership
    const alreadyMember = await repo.activeMembershipExistsByEmail(orgId, normalizedEmail);
    if (alreadyMember) {
      skipped.push({
        email: normalizedEmail,
        role,
        reason: 'duplicate_existing_member',
      });
      continue;
    }

    // Check duplicate pending invitation
    const alreadyInvited = await repo.activeMembershipOrInvitationExists(orgId, normalizedEmail);
    if (alreadyInvited) {
      skipped.push({
        email: normalizedEmail,
        role,
        reason: 'duplicate_pending_invitation',
      });
      continue;
    }

    // Create invitation
    const inviteRole = role as OrgRole;
    const invitationId = randomUUID();
    const { rawToken, tokenHash } = generateToken();
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + INVITATION_TTL_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const item: InvitationDynamoItem = {
      PK: `ORG#${orgId}`,
      SK: `INVITATION#${invitationId}`,
      GSI1PK: `TOKEN#${tokenHash}`,
      GSI1SK: 'INVITATION',
      GSI2PK: `ORG#${orgId}#EMAIL#${normalizedEmail}`,
      GSI2SK: 'INVITATION',
      type: 'INVITATION',
      invitationId,
      orgId,
      email: normalizedEmail,
      role: inviteRole,
      status: 'Pending',
      tokenHash,
      expiresAt,
      createdAt,
      tenantId: orgId,
    };

    try {
      await repo.createInvitation(item);
      await enqueueInvitationEmail(
        orgId,
        invitationId,
        normalizedEmail,
        inviteRole,
        rawToken,
        expiresAt,
      );
      accepted.push({ email: normalizedEmail, role: inviteRole });
    } catch {
      skipped.push({ email: normalizedEmail, role: inviteRole, reason: 'internal_error' });
    }
  }

  // Audit log for bulk submission
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: callerMemberId,
    targetType: 'INVITATION_BULK',
    targetId: orgId,
    operation: 'member.bulk_invite',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: {
      totalRows: rows.length,
      acceptedCount: accepted.length,
      skippedCount: skipped.length,
    },
  });

  return {
    accepted,
    skipped,
    totalRows: rows.length,
  };
}

/**
 * Accepts an invitation by token (public endpoint — no JWT required).
 * - Looks up invitation via GSI1 (TOKEN#{hash})
 * - Validates: expiry, status (must be Pending)
 * - Creates OrgMembership record
 * - Marks invitation as Accepted
 * - Writes audit log
 */
export async function acceptInvitation(
  rawToken: string,
  acceptingMemberId: string,
  sourceIp: string,
): Promise<{ orgId: string; role: OrgRole; invitationId: string }> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  const invitation = await repo.getInvitationByTokenHash(tokenHash);

  if (!invitation) {
    throw Object.assign(new Error('Invitation not found or already used.'), {
      statusCode: 404,
      errorCode: 'invitation.not_found',
    });
  }

  // Check expiry
  if (new Date() > new Date(invitation.expiresAt)) {
    throw Object.assign(new Error('This invitation link has expired.'), {
      statusCode: 410,
      errorCode: 'invitation.expired',
    });
  }

  // Check used status
  if (invitation.status !== 'Pending') {
    throw Object.assign(new Error('This invitation link has already been used.'), {
      statusCode: 409,
      errorCode: 'invitation.already_used',
    });
  }

  const now = new Date().toISOString();

  // Create OrgMembership
  const membershipItem: MembershipDynamoItem = {
    PK: `ORG#${invitation.orgId}`,
    SK: `MEMBER#${acceptingMemberId}`,
    GSI1PK: `MEMBER#${acceptingMemberId}`,
    GSI1SK: `ORG#${invitation.orgId}`,
    type: 'ORG_MEMBERSHIP',
    orgId: invitation.orgId,
    memberId: acceptingMemberId,
    role: invitation.role,
    status: 'Active',
    tenantId: invitation.orgId,
    joinedAt: now,
    updatedAt: now,
  };

  await repo.createMembership(membershipItem);

  // Mark invitation as Accepted (conditional — idempotency guard)
  await repo.markInvitationAccepted(invitation.orgId, invitation.invitationId);

  // Audit log
  await writeAuditLog({
    timestamp: now,
    actor: acceptingMemberId,
    targetType: 'INVITATION',
    targetId: invitation.invitationId,
    operation: 'member.invite_accept',
    sourceIp,
    outcome: 'success',
    orgId: invitation.orgId,
  });

  return {
    orgId: invitation.orgId,
    role: invitation.role,
    invitationId: invitation.invitationId,
  };
}

/**
 * Lists paginated members of an org.
 * tenantId is always sourced from JWT authorizer context.
 */
export async function listMembers(
  orgId: string,
  tenantId: string,
  callerRole: string,
  limit = 20,
  nextToken?: string,
): Promise<{ members: OrgMember[]; nextToken?: string }> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'member.access_denied',
    });
  }

  // Any authenticated member of the org can list members
  // (RBAC enforced at authorizer; Member role can view)
  void callerRole;

  let lastKey: Record<string, unknown> | undefined;
  if (nextToken) {
    try {
      lastKey = JSON.parse(Buffer.from(nextToken, 'base64').toString('utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw Object.assign(new Error('Invalid pagination token.'), {
        statusCode: 400,
        errorCode: 'validation.invalid_token',
      });
    }
  }

  const { members: items, lastEvaluatedKey } = await repo.listMembers(
    orgId,
    tenantId,
    limit,
    lastKey,
  );

  const members = items.map(toMember);
  const newNextToken = lastEvaluatedKey
    ? Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64')
    : undefined;

  return { members, nextToken: newNextToken };
}

/**
 * Changes a member's role.
 * - Enforces sole-owner guard: cannot demote the last Owner.
 * - Requires Admin or Owner role.
 * - Writes audit log.
 */
export async function changeMemberRole(
  orgId: string,
  tenantId: string,
  callerRole: string,
  callerMemberId: string,
  targetMemberId: string,
  newRole: string,
  sourceIp: string,
): Promise<OrgMember> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'member.access_denied',
    });
  }

  assertPermission(callerRole, 'members:change-role');

  if (!validateInviteRole(newRole)) {
    throw Object.assign(
      new Error(`Role must be one of: ${VALID_INVITE_ROLES.join(', ')}.`),
      { statusCode: 400, errorCode: 'member.invalid_role' },
    );
  }

  const newOrgRole = newRole as OrgRole;

  // Fetch current membership to check existing role
  const existing = await repo.getMembership(orgId, targetMemberId, tenantId);
  if (!existing || existing.status === 'Removed') {
    throw Object.assign(new Error('Member not found in this organization.'), {
      statusCode: 403,
      errorCode: 'member.not_found',
    });
  }

  // Sole-owner guard: if demoting an Owner, ensure there's at least one other Owner
  if (existing.role === 'Owner' && newOrgRole !== 'Owner') {
    const ownerCount = await repo.countOwners(orgId, tenantId);
    if (ownerCount <= 1) {
      throw Object.assign(
        new Error(
          'Cannot demote or remove the sole Owner. Transfer ownership to another member first.',
        ),
        { statusCode: 409, errorCode: 'member.sole_owner_guard' },
      );
    }
  }

  const updated = await repo.updateMemberRole(orgId, targetMemberId, tenantId, newOrgRole);

  // Audit log
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: callerMemberId,
    targetType: 'MEMBER',
    targetId: targetMemberId,
    operation: 'member.role_change',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: { previousRole: existing.role, newRole: newOrgRole },
  });

  return toMember(updated);
}

/**
 * Removes a member from the organization.
 * - Enforces sole-owner guard: cannot remove the last Owner.
 * - Revokes access by setting membership status to Removed.
 * - Writes audit log.
 * Note: Cancellation of pending tickets is enqueued asynchronously via SQS.
 */
export async function removeMember(
  orgId: string,
  tenantId: string,
  callerRole: string,
  callerMemberId: string,
  targetMemberId: string,
  sourceIp: string,
): Promise<void> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'member.access_denied',
    });
  }

  assertPermission(callerRole, 'members:remove');

  // Fetch current membership
  const existing = await repo.getMembership(orgId, targetMemberId, tenantId);
  if (!existing || existing.status === 'Removed') {
    throw Object.assign(new Error('Member not found in this organization.'), {
      statusCode: 403,
      errorCode: 'member.not_found',
    });
  }

  // Sole-owner guard
  if (existing.role === 'Owner') {
    const ownerCount = await repo.countOwners(orgId, tenantId);
    if (ownerCount <= 1) {
      throw Object.assign(
        new Error(
          'Cannot remove the sole Owner. Transfer ownership to another member first.',
        ),
        { statusCode: 409, errorCode: 'member.sole_owner_guard' },
      );
    }
  }

  await repo.removeMember(orgId, targetMemberId, tenantId);

  // Enqueue ticket cancellation task via SQS (async — not on critical path)
  if (NOTIFICATION_QUEUE_URL) {
    try {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: NOTIFICATION_QUEUE_URL,
          MessageBody: JSON.stringify({
            type: 'CANCEL_MEMBER_TICKETS',
            orgId,
            memberId: targetMemberId,
          }),
          MessageGroupId: orgId,
        }),
      );
    } catch {
      // Non-blocking — ticket cancellation will be retried via DLQ
    }
  }

  // Audit log
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: callerMemberId,
    targetType: 'MEMBER',
    targetId: targetMemberId,
    operation: 'member.remove',
    sourceIp,
    outcome: 'success',
    orgId,
  });
}
