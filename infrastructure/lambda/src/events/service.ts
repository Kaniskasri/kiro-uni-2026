import { randomUUID } from 'crypto';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import * as repo from './repository';
import { assertPermission } from '../shared/layers/rbac';
import { writeAuditLog } from '../shared/middleware/writeAuditLog';
import {
  Event,
  EventDynamoItem,
  EventStatus,
  CreateEventRequest,
  UpdateEventRequest,
  VALID_TRANSITIONS,
} from './types';

// ─── Validation constants ──────────────────────────────────────────────────────

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const CAPACITY_MIN = 1;
const CAPACITY_MAX = 100_000;

// IANA timezone format validation — checks the canonical TZ database format
// e.g. Asia/Kolkata, America/New_York, Europe/London, UTC
// Single-word abbreviations like EST, PST are NOT valid IANA identifiers.
// Valid formats: UTC, Etc/UTC, Etc/GMT+5, or Continent/City (must contain a slash).
const IANA_TZ_REGEX = /^UTC$|^Etc\/[A-Za-z0-9+_-]+$|^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/;

const eventBridge = new EventBridgeClient({
  region: process.env['AWS_REGION'] ?? 'us-east-1',
});

// ─── Validation helpers ────────────────────────────────────────────────────────

export function validateEventTitle(title: string): void {
  if (typeof title !== 'string' || title.trim().length < TITLE_MIN || title.length > TITLE_MAX) {
    throw Object.assign(
      new Error(`Event title must be between ${TITLE_MIN} and ${TITLE_MAX} characters.`),
      { statusCode: 400, errorCode: 'event.invalid_title' },
    );
  }
}

export function validateEventCapacity(capacity: number): void {
  if (
    typeof capacity !== 'number' ||
    !Number.isInteger(capacity) ||
    capacity < CAPACITY_MIN ||
    capacity > CAPACITY_MAX
  ) {
    throw Object.assign(
      new Error(
        `Event capacity must be an integer between ${CAPACITY_MIN} and ${CAPACITY_MAX}.`,
      ),
      { statusCode: 400, errorCode: 'event.invalid_capacity' },
    );
  }
}

export function validateISODateTime(value: string, fieldName: string): void {
  // Must be a valid UTC ISO 8601 datetime string
  const iso8601Regex =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof value !== 'string' || !iso8601Regex.test(value)) {
    throw Object.assign(
      new Error(`${fieldName} must be a valid UTC ISO 8601 datetime string (e.g. 2026-10-15T14:00:00Z).`),
      { statusCode: 400, errorCode: 'event.invalid_datetime' },
    );
  }
  // Check that the date is parseable
  const ts = Date.parse(value);
  if (isNaN(ts)) {
    throw Object.assign(
      new Error(`${fieldName} is not a valid date-time value.`),
      { statusCode: 400, errorCode: 'event.invalid_datetime' },
    );
  }
}

export function validateTimezone(timezone: string): void {
  if (typeof timezone !== 'string' || !IANA_TZ_REGEX.test(timezone)) {
    throw Object.assign(
      new Error(
        'timezone must be a valid IANA timezone identifier (e.g. Asia/Kolkata, America/New_York, UTC).',
      ),
      { statusCode: 400, errorCode: 'event.invalid_timezone' },
    );
  }
}

export function validateDateRange(startAt: string, endAt: string): void {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (end <= start) {
    throw Object.assign(
      new Error('endAt must be after startAt.'),
      { statusCode: 400, errorCode: 'event.invalid_date_range' },
    );
  }
}

// ─── Item mapper ───────────────────────────────────────────────────────────────

function toEvent(item: EventDynamoItem): Event {
  return {
    eventId: item.eventId,
    orgId: item.orgId,
    title: item.title,
    description: item.description,
    status: item.status,
    startAt: item.startAt,
    endAt: item.endAt,
    timezone: item.timezone,
    capacity: item.capacity,
    venueId: item.venueId,
    address: item.address,
    meetingUrl: item.meetingUrl,
    isVirtual: item.isVirtual,
    tenantId: item.tenantId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ─── Service operations ────────────────────────────────────────────────────────

/**
 * Creates a new Event in Draft status. Requires Organizer role.
 * tenantId is always sourced from the JWT authorizer context.
 */
export async function createEvent(
  orgId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  input: CreateEventRequest,
): Promise<Event> {
  assertPermission(callerRole, 'events:create');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  // Validate required fields
  validateEventTitle(input.title);
  validateISODateTime(input.startAt, 'startAt');
  validateISODateTime(input.endAt, 'endAt');
  validateDateRange(input.startAt, input.endAt);
  validateTimezone(input.timezone);
  validateEventCapacity(input.capacity);

  // Validate event type requirements
  const isVirtual = input.isVirtual ?? false;
  if (!isVirtual) {
    // Physical event: venueId + address required
    if (!input.venueId && !input.address) {
      throw Object.assign(
        new Error('Physical events require a venueId or address.'),
        { statusCode: 400, errorCode: 'event.missing_location' },
      );
    }
  } else {
    // Virtual event: meetingUrl required
    if (!input.meetingUrl) {
      throw Object.assign(
        new Error('Virtual events require a meetingUrl.'),
        { statusCode: 400, errorCode: 'event.missing_meeting_url' },
      );
    }
  }

  const eventId = randomUUID();

  const dynamoItem = await repo.createEvent({
    PK: `ORG#${orgId}#EVENT#${eventId}`,
    SK: 'METADATA',
    GSI2PK: `ORG#${orgId}#STATUS#Draft`,
    GSI2SK: input.startAt,
    type: 'EVENT',
    eventId,
    orgId,
    title: input.title,
    description: input.description,
    status: 'Draft',
    startAt: input.startAt,
    endAt: input.endAt,
    timezone: input.timezone,
    capacity: input.capacity,
    venueId: input.venueId,
    address: input.address,
    meetingUrl: input.meetingUrl,
    isVirtual,
    tenantId,
  });

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'EVENT',
    targetId: eventId,
    operation: 'event.create',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return toEvent(dynamoItem);
}

/**
 * Lists events for an org with cursor-based pagination.
 * Optionally filters by status via GSI2.
 */
export async function listEvents(
  orgId: string,
  tenantId: string,
  limit: number,
  status?: EventStatus,
  nextToken?: string,
): Promise<{ events: Event[]; nextToken?: string }> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const result = await repo.listEventsByOrg(orgId, tenantId, limit, status, nextToken);
  return {
    events: result.events.map(toEvent),
    nextToken: result.nextToken,
  };
}

/**
 * Returns a single Event. Cross-org access → 403 (never 404).
 */
export async function getEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
): Promise<Event> {
  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const item = await repo.getEventById(orgId, eventId, tenantId);
  if (!item) {
    // Return 403 not 404 to avoid leaking existence info cross-org
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  return toEvent(item);
}

/**
 * Updates mutable event fields. Requires Organizer role.
 */
export async function updateEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  updates: UpdateEventRequest,
): Promise<Event> {
  assertPermission(callerRole, 'events:edit');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  // Validate changed fields
  if (updates.title !== undefined) validateEventTitle(updates.title);
  if (updates.startAt !== undefined) validateISODateTime(updates.startAt, 'startAt');
  if (updates.endAt !== undefined) validateISODateTime(updates.endAt, 'endAt');
  if (updates.timezone !== undefined) validateTimezone(updates.timezone);
  if (updates.capacity !== undefined) validateEventCapacity(updates.capacity);

  // Fetch existing event to compute endAt/startAt for range check
  const existing = await repo.getEventById(orgId, eventId, tenantId);
  if (!existing) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const effectiveStartAt = updates.startAt ?? existing.startAt;
  const effectiveEndAt = updates.endAt ?? existing.endAt;
  if (updates.startAt !== undefined || updates.endAt !== undefined) {
    validateDateRange(effectiveStartAt, effectiveEndAt);
  }

  const item = await repo.updateEvent(orgId, eventId, tenantId, updates);

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'EVENT',
    targetId: eventId,
    operation: 'event.update',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return toEvent(item);
}

/**
 * Publishes an Event: Draft → Published.
 * Emits a CloudEvents-schema domain event to EventBridge.
 * Requires Organizer role.
 */
export async function publishEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
): Promise<Event> {
  assertPermission(callerRole, 'events:publish');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const existing = await repo.getEventById(orgId, eventId, tenantId);
  if (!existing) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  if (existing.status !== 'Draft') {
    throw Object.assign(
      new Error(
        `Cannot publish event. Expected status Draft but current status is ${existing.status}. ` +
          'Only Draft events can be published.',
      ),
      { statusCode: 400, errorCode: 'event.invalid_transition' },
    );
  }

  const updated = await repo.transitionEventStatus(
    orgId,
    eventId,
    tenantId,
    'Draft',
    'Published',
  );

  // Emit CloudEvents-schema domain event to EventBridge
  const eventBusName = process.env['EVENT_BUS_NAME'] ?? 'default';
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: eventBusName,
          Source: 'clois/events',
          DetailType: 'com.clois.v1.events.published',
          Detail: JSON.stringify({
            specversion: '1.0',
            type: 'com.clois.v1.events.published',
            source: 'clois/events',
            id: randomUUID(),
            time: new Date().toISOString(),
            datacontenttype: 'application/json',
            data: {
              eventId: updated.eventId,
              orgId: updated.orgId,
              title: updated.title,
              startAt: updated.startAt,
              endAt: updated.endAt,
            },
          }),
        },
      ],
    }),
  );

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'EVENT',
    targetId: eventId,
    operation: 'event.publish',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return toEvent(updated);
}

/**
 * Cancels an Event. Valid from Draft, Published, Open, or In_Progress.
 * Requires Organizer role.
 */
export async function cancelEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
): Promise<Event> {
  assertPermission(callerRole, 'events:cancel');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const existing = await repo.getEventById(orgId, eventId, tenantId);
  if (!existing) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const cancellableStatuses: EventStatus[] = ['Draft', 'Published', 'Open', 'In_Progress'];
  if (!cancellableStatuses.includes(existing.status)) {
    throw Object.assign(
      new Error(
        `Cannot cancel event. Current status is ${existing.status}. ` +
          'Only Draft, Published, Open, or In_Progress events can be cancelled.',
      ),
      { statusCode: 400, errorCode: 'event.invalid_transition' },
    );
  }

  const updated = await repo.transitionEventStatus(
    orgId,
    eventId,
    tenantId,
    existing.status,
    'Cancelled',
  );

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'EVENT',
    targetId: eventId,
    operation: 'event.cancel',
    sourceIp,
    outcome: 'success',
    orgId,
  });

  return toEvent(updated);
}

/**
 * Admin manual state transition override. Validates against the state machine.
 * Requires Admin role. Writes audit log entry.
 */
export async function transitionEvent(
  orgId: string,
  eventId: string,
  tenantId: string,
  callerRole: string,
  actorId: string,
  sourceIp: string,
  targetStatus: EventStatus,
): Promise<Event> {
  assertPermission(callerRole, 'events:transition-admin');

  if (tenantId !== orgId) {
    throw Object.assign(new Error('Access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const existing = await repo.getEventById(orgId, eventId, tenantId);
  if (!existing) {
    throw Object.assign(new Error('Event not found or access denied.'), {
      statusCode: 403,
      errorCode: 'event.access_denied',
    });
  }

  const validNextStatuses = VALID_TRANSITIONS[existing.status];
  if (!validNextStatuses.includes(targetStatus)) {
    throw Object.assign(
      new Error(
        `Invalid state transition: cannot move event from ${existing.status} to ${targetStatus}. ` +
          `Valid transitions from ${existing.status}: ${validNextStatuses.length > 0 ? validNextStatuses.join(', ') : 'none (terminal state)'}.`,
      ),
      { statusCode: 400, errorCode: 'event.invalid_transition' },
    );
  }

  const updated = await repo.transitionEventStatus(
    orgId,
    eventId,
    tenantId,
    existing.status,
    targetStatus,
  );

  await writeAuditLog({
    timestamp: new Date().toISOString(),
    actor: actorId,
    targetType: 'EVENT',
    targetId: eventId,
    operation: 'event.transition',
    sourceIp,
    outcome: 'success',
    orgId,
    metadata: { fromStatus: existing.status, toStatus: targetStatus },
  });

  return toEvent(updated);
}
