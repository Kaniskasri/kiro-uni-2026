import { randomUUID } from 'crypto';
import * as repo from './repository';
import { assertPermission } from '../shared/layers/rbac';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import { Venue, VenueDynamoItem, BlockingEvent } from './types';

// ─── Validation constants ──────────────────────────────────────────────────────

const NAME_MIN = 1;
const NAME_MAX = 200;
const ADDRESS_MIN = 1;
const ADDRESS_MAX = 500;
const CAPACITY_MIN = 1;
const CAPACITY_MAX = 999_999;
const AMENITIES_MAX_COUNT = 50;
const AMENITY_MAX_LENGTH = 100;

// ─── Validation helpers ────────────────────────────────────────────────────────

export function validateVenueName(name: string): void {
  if (typeof name !== 'string' || name.length < NAME_MIN || name.length > NAME_MAX) {
    throw Object.assign(
      new Error(`Venue name must be between ${NAME_MIN} and ${NAME_MAX} characters.`),
      { statusCode: 400, errorCode: 'venue.invalid_name' },
    );
  }
}

export function validateVenueAddress(address: string): void {
  if (typeof address !== 'string' || address.length < ADDRESS_MIN || address.length > ADDRESS_MAX) {
    throw Object.assign(
      new Error(`Venue address must be between ${ADDRESS_MIN} and ${ADDRESS_MAX} characters.`),
      { statusCode: 400, errorCode: 'venue.invalid_address' },
    );
  }
}

export function validateVenueCapacity(capacity: number): void {
  if (
    typeof capacity !== 'number' ||
    !Number.isInteger(capacity) ||
    capacity < CAPACITY_MIN ||
    capacity > CAPACITY_MAX
  ) {
    throw Object.assign(
      new Error(
        `Venue capacity must be an integer between ${CAPACITY_MIN} and ${CAPACITY_MAX}.`,
      ),
      { statusCode: 400, errorCode: 'venue.invalid_capacity' },
    );
  }
}

export function validateAmenities(amenities: string[]): void {
  if (!Array.isArray(amenities)) {
    throw Object.assign(new Error('Amenities must be an array.'), {
      statusCode: 400,
      errorCode: 'venue.invalid_amenities',
    });
  }
  if (amenities.length > AMENITIES_MAX_COUNT) {
    throw Object.assign(
      new Error(`Amenities list must not exceed ${AMENITIES_MAX_COUNT} items.`),
      { statusCode: 400, errorCode: 'venue.amenities_too_many' },
    );
  }
  for (const item of amenities) {
    if (typeof item !== 'string' || item.length < 1 || item.length > AMENITY_MAX_LENGTH) {
      throw Object.assign(
        new Error(`Each amenity must be between 1 and ${AMENITY_MAX_LENGTH} characters.`),
        { statusCode: 400, errorCode: 'venue.invalid_amenity_item' },
      );
    }
  }
}

// ─── Item mapper ───────────────────────────────────────────────────────────────

function toVenue(item: VenueDynamoItem): Venue {
  return {
    venueId: item.venueId,
    orgId: item.orgId,
    name: item.name,
    address: item.address,
    capacity: item.capacity,
    amenities: item.amenities,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    tenantId: item.tenantId,
  };
}

// ─── Service operations ────────────────────────────────────────────────────────

/**
 * Creates a new Venue. Requires Organizer role.
 * tenantId is always sourced from the JWT authorizer context.
 */
export async function createVenue(
  orgId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  input: {
    name: string;
    address: string;
    capacity: number;
    amenities?: string[];
  },
): Promise<Venue> {
  assertPermission(callerRole, 'venues:create');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'venue.access_denied',
    });
  }

  validateVenueName(input.name);
  validateVenueAddress(input.address);
  validateVenueCapacity(input.capacity);
  const amenities = input.amenities ?? [];
  validateAmenities(amenities);

  const venueId = randomUUID();

  const dynamoItem = await repo.createVenue({
    PK: `ORG#${orgId}#VENUE#${venueId}`,
    SK: 'METADATA',
    GSI1PK: `ORG#${orgId}`,
    GSI1SK: `VENUE#${venueId}`,
    type: 'VENUE',
    venueId,
    orgId,
    name: input.name,
    address: input.address,
    capacity: input.capacity,
    amenities,
    tenantId,
  });

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'VENUE',
    targetId: venueId,
    operation: 'venue.create',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return toVenue(dynamoItem);
}

/**
 * Lists all venues for an org with cursor-based pagination.
 * tenantId is always sourced from the JWT authorizer context.
 */
export async function listVenues(
  orgId: string,
  tenantId: string,
  limit: number,
  nextToken?: string,
): Promise<{ venues: Venue[]; nextToken?: string }> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'venue.access_denied',
    });
  }

  const result = await repo.listVenuesByOrg(orgId, tenantId, limit, nextToken);
  return {
    venues: result.venues.map(toVenue),
    nextToken: result.nextToken,
  };
}

/**
 * Returns a single Venue. Cross-org access → 403 (never 404).
 * tenantId is always sourced from the JWT authorizer context.
 */
export async function getVenue(
  orgId: string,
  venueId: string,
  tenantId: string,
): Promise<Venue> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'venue.access_denied',
    });
  }

  const item = await repo.getVenueById(orgId, venueId, tenantId);
  if (!item) {
    // Return 403 not 404 to avoid leaking existence info cross-org
    throw Object.assign(new Error('Venue not found or access denied.'), {
      statusCode: 403,
      errorCode: 'venue.access_denied',
    });
  }

  return toVenue(item);
}

/**
 * Updates mutable venue fields. Requires Organizer role.
 * tenantId is always sourced from the JWT authorizer context.
 */
export async function updateVenue(
  orgId: string,
  venueId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  updates: {
    name?: string;
    address?: string;
    capacity?: number;
    amenities?: string[];
  },
): Promise<Venue> {
  assertPermission(callerRole, 'venues:edit');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'venue.access_denied',
    });
  }

  if (updates.name !== undefined) validateVenueName(updates.name);
  if (updates.address !== undefined) validateVenueAddress(updates.address);
  if (updates.capacity !== undefined) validateVenueCapacity(updates.capacity);
  if (updates.amenities !== undefined) validateAmenities(updates.amenities);

  const item = await repo.updateVenue(orgId, venueId, tenantId, updates);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'VENUE',
    targetId: venueId,
    operation: 'venue.update',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return toVenue(item);
}

/**
 * Deletes a Venue. Requires Admin role.
 * Guard: reject if the venue is used by any Published or Open event.
 * Returns the list of blocking events if deletion is blocked.
 */
export async function deleteVenue(
  orgId: string,
  venueId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
): Promise<void> {
  assertPermission(callerRole, 'venues:delete');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'venue.access_denied',
    });
  }

  // Verify venue exists (403 if not, per cross-org rule)
  const existing = await repo.getVenueById(orgId, venueId, tenantId);
  if (!existing) {
    throw Object.assign(new Error('Venue not found or access denied.'), {
      statusCode: 403,
      errorCode: 'venue.access_denied',
    });
  }

  // Guard: reject if venue is referenced by any Published or Open events
  const blockingEvents: BlockingEvent[] = await repo.getBlockingEvents(orgId, venueId, tenantId);
  if (blockingEvents.length > 0) {
    throw Object.assign(
      new Error(
        'Venue cannot be deleted because it is used by one or more active events.',
      ),
      {
        statusCode: 409,
        errorCode: 'venue.has_active_events',
        blockingEvents,
      },
    );
  }

  await repo.deleteVenue(orgId, venueId, tenantId);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'VENUE',
    targetId: venueId,
    operation: 'venue.delete',
    sourceIp,
    outcome: 'success',
    orgId,
  });
}
