import { randomUUID } from 'crypto';
import * as repo from './repository';
import { assertPermission } from '../shared/layers/rbac';
import {
  Organization,
  OrgMembership,
  OrgSettings,
  OrgDynamoItem,
  MembershipDynamoItem,
} from './types';

// ─── Validation helpers ───────────────────────────────────────────────────────

const NAME_MIN = 3;
const NAME_MAX = 100;
const SLUG_MIN = 3;
const SLUG_MAX = 63;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export function validateOrgName(name: string): void {
  if (typeof name !== 'string' || name.length < NAME_MIN || name.length > NAME_MAX) {
    throw Object.assign(
      new Error(`Organization name must be between ${NAME_MIN} and ${NAME_MAX} characters.`),
      { statusCode: 400, errorCode: 'org.invalid_name' },
    );
  }
}

export function validateSlug(slug: string): void {
  if (
    typeof slug !== 'string' ||
    slug.length < SLUG_MIN ||
    slug.length > SLUG_MAX ||
    !SLUG_REGEX.test(slug)
  ) {
    throw Object.assign(
      new Error(
        `Slug must be ${SLUG_MIN}–${SLUG_MAX} characters, lowercase alphanumeric and hyphens only, and must not start or end with a hyphen.`,
      ),
      { statusCode: 400, errorCode: 'org.invalid_slug' },
    );
  }
}

// ─── Item mappers ─────────────────────────────────────────────────────────────

function toOrganization(item: OrgDynamoItem): Organization {
  return {
    orgId: item.orgId,
    name: item.name,
    slug: item.slug,
    status: item.status,
    settings: item.settings,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    tenantId: item.tenantId,
  };
}

function toMembership(item: MembershipDynamoItem): OrgMembership {
  return {
    orgId: item.orgId,
    memberId: item.memberId,
    role: item.role,
    joinedAt: item.joinedAt,
    tenantId: item.tenantId,
  };
}

// ─── Service operations ───────────────────────────────────────────────────────

/**
 * Creates a new organization. The caller becomes the Owner.
 * tenantId is set equal to the newly generated orgId.
 */
export async function createOrg(
  memberId: string,
  name: string,
  slug: string,
  settings: OrgSettings = {},
): Promise<{ org: Organization; membership: OrgMembership }> {
  validateOrgName(name);
  validateSlug(slug);

  // Case-insensitive slug uniqueness check
  const normalizedSlug = slug.toLowerCase();
  const exists = await repo.slugExists(normalizedSlug);
  if (exists) {
    throw Object.assign(new Error('An organization with this slug already exists.'), {
      statusCode: 409,
      errorCode: 'org.slug_already_exists',
    });
  }

  const orgId = randomUUID();
  const orgItem = await repo.createOrgWithOwner(orgId, memberId, name, normalizedSlug, settings);

  const org = toOrganization(orgItem);
  const membership: OrgMembership = {
    orgId,
    memberId,
    role: 'Owner',
    joinedAt: orgItem.createdAt,
    tenantId: orgId,
  };

  return { org, membership };
}

/**
 * Returns the organization record. Cross-org attempts → 403.
 * tenantId MUST come from the JWT authorizer context, not the request.
 */
export async function getOrg(orgId: string, tenantId: string): Promise<Organization> {
  // tenantId sourced from JWT; if it differs from orgId, it's a cross-org attempt
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'org.access_denied',
    });
  }

  const item = await repo.getOrgById(orgId, tenantId);
  if (!item) {
    // Return 403 not 404 to avoid leaking existence info cross-org
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'org.access_denied',
    });
  }

  return toOrganization(item);
}

/**
 * Updates org name / settings. Requires Owner role.
 */
export async function updateOrg(
  orgId: string,
  tenantId: string,
  callerRole: string,
  updates: { name?: string; settings?: OrgSettings },
): Promise<Organization> {
  assertPermission(callerRole, 'org:update');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'org.access_denied',
    });
  }

  if (updates.name !== undefined) {
    validateOrgName(updates.name);
  }

  const item = await repo.updateOrg(orgId, tenantId, updates);
  return toOrganization(item);
}

/**
 * Deactivates the organization. Requires Owner role.
 * Data is retained for ≥ 90 days per Req 2.5.
 */
export async function deactivateOrg(
  orgId: string,
  tenantId: string,
  callerRole: string,
  sourceIp: string,
  actorId: string,
): Promise<void> {
  assertPermission(callerRole, 'org:deactivate');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'org.access_denied',
    });
  }

  await repo.deactivateOrg(orgId, tenantId);

  // Audit log — org deactivation is a security-relevant operation
  await repo.writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'ORGANIZATION',
    targetId: orgId,
    operation: 'org.deactivate',
    sourceIp,
    outcome: 'success',
    orgId,
  });
}

/**
 * Transfers organization ownership to another existing member.
 * Requires Owner role. Target must already be an org member.
 */
export async function transferOwnership(
  orgId: string,
  tenantId: string,
  callerRole: string,
  callerMemberId: string,
  targetMemberId: string,
  sourceIp: string,
): Promise<void> {
  assertPermission(callerRole, 'org:transfer-ownership');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'org.access_denied',
    });
  }

  if (callerMemberId === targetMemberId) {
    throw Object.assign(new Error('Cannot transfer ownership to yourself.'), {
      statusCode: 400,
      errorCode: 'org.transfer_ownership_self',
    });
  }

  // Validate that the target is an existing member of this org
  const targetMembership = await repo.getMembership(orgId, targetMemberId, tenantId);
  if (!targetMembership) {
    throw Object.assign(
      new Error('Target member does not exist in this organization.'),
      { statusCode: 400, errorCode: 'org.target_not_member' },
    );
  }

  await repo.transferOwnership(orgId, tenantId, callerMemberId, targetMemberId);

  // Audit log — ownership transfer is a security-relevant operation
  await repo.writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: callerMemberId,
    targetType: 'ORGANIZATION',
    targetId: orgId,
    operation: 'org.transfer_ownership',
    sourceIp,
    outcome: 'success',
    orgId,
  });
}
