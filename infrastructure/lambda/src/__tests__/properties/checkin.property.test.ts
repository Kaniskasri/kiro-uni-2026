// Feature: clois, Property 15: Check-In Idempotency
// Re-checking in a ticket that is already CheckedIn always returns
// the original checkedInAt timestamp, never creates a second record.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'crypto';

// ─── Domain types (mirrored for self-contained simulation) ─────────────────────

type TicketStatus = 'Confirmed' | 'Waitlisted' | 'Cancelled' | 'CheckedIn';
type EventStatus =
  | 'Draft'
  | 'Published'
  | 'Open'
  | 'In_Progress'
  | 'Completed'
  | 'Cancelled'
  | 'Archived';

interface SimTicket {
  ticketId: string;
  ticketCode: string;
  orgId: string;
  eventId: string;
  memberId?: string;
  guestEmail?: string;
  guestName?: string;
  status: TicketStatus;
  checkedInAt?: string;
  checkedInBy?: string;
  tenantId: string;
}

interface SimEvent {
  eventId: string;
  orgId: string;
  status: EventStatus;
  capacity: number;
  tenantId: string;
}

type CheckInResult =
  | { success: true; checkedInAt: string; checkedInBy: string; alreadyCheckedIn: boolean }
  | { success: false; statusCode: number; errorCode: string };

// ─── Pure simulation of check-in logic (mirrors service.ts) ───────────────────

/**
 * Simulates a single check-in operation.
 * Returns the outcome without side effects.
 * This pure function is what the property tests exercise.
 */
function simulateCheckIn(
  event: SimEvent,
  ticket: SimTicket | undefined,
  actorId: string,
  orgId: string,
  eventId: string,
): CheckInResult {
  // Event must be In_Progress
  if (!event || event.status !== 'In_Progress') {
    return { success: false, statusCode: 400, errorCode: 'checkin.event_not_in_progress' };
  }

  // Tenant isolation
  if (event.orgId !== orgId || event.tenantId !== orgId) {
    return { success: false, statusCode: 403, errorCode: 'checkin.access_denied' };
  }

  // Ticket must exist
  if (!ticket) {
    return { success: false, statusCode: 404, errorCode: 'checkin.ticket_not_found' };
  }

  // Ticket must belong to same event/org
  if (ticket.eventId !== eventId || ticket.orgId !== orgId) {
    return { success: false, statusCode: 404, errorCode: 'checkin.ticket_not_found' };
  }

  // Idempotency: already checked in → return original timestamp
  if (ticket.status === 'CheckedIn') {
    return {
      success: true,
      checkedInAt: ticket.checkedInAt!,
      checkedInBy: ticket.checkedInBy ?? actorId,
      alreadyCheckedIn: true,
    };
  }

  if (ticket.status === 'Cancelled') {
    return { success: false, statusCode: 400, errorCode: 'checkin.ticket_cancelled' };
  }

  if (ticket.status === 'Waitlisted') {
    return { success: false, statusCode: 400, errorCode: 'checkin.ticket_waitlisted' };
  }

  // Confirmed → check in
  const checkedInAt = new Date().toISOString();
  return {
    success: true,
    checkedInAt,
    checkedInBy: actorId,
    alreadyCheckedIn: false,
  };
}

/**
 * Applies a successful check-in result to the ticket state.
 */
function applyCheckIn(ticket: SimTicket, result: CheckInResult): SimTicket {
  if (!result.success || result.alreadyCheckedIn) return ticket;
  return {
    ...ticket,
    status: 'CheckedIn',
    checkedInAt: result.checkedInAt,
    checkedInBy: result.checkedInBy,
  };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

const memberIdArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-z0-9_-]+$/.test(s) && s.length >= 1);

const orgIdArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-z0-9_-]+$/.test(s) && s.length >= 1);

const ticketCodeArb = fc.constant('').map(() => randomUUID());

const validIso8601Arb = fc
  .integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 })
  .map((ms) => new Date(ms).toISOString());

/** Generates an In_Progress event. */
const inProgressEventArb = fc
  .record({
    orgId: orgIdArb,
    capacity: fc.integer({ min: 1, max: 500 }),
  })
  .map(({ orgId, capacity }) => ({
    eventId: randomUUID(),
    orgId,
    status: 'In_Progress' as EventStatus,
    capacity,
    tenantId: orgId,
  }));

/** Generates a non-In_Progress event status. */
const nonInProgressStatusArb = fc.constantFrom<EventStatus>(
  'Draft',
  'Published',
  'Open',
  'Completed',
  'Cancelled',
  'Archived',
);

/** Generates a Confirmed ticket belonging to a given event. */
function confirmedTicketArb(event: SimEvent): fc.Arbitrary<SimTicket> {
  return fc
    .record({ memberId: memberIdArb })
    .map(({ memberId }) => ({
      ticketId: randomUUID(),
      ticketCode: randomUUID(),
      orgId: event.orgId,
      eventId: event.eventId,
      memberId,
      status: 'Confirmed' as TicketStatus,
      tenantId: event.tenantId,
    }));
}

/** Generates a CheckedIn ticket with a pre-existing timestamp. */
function checkedInTicketArb(event: SimEvent): fc.Arbitrary<SimTicket> {
  return fc
    .record({ memberId: memberIdArb, checkedInAt: validIso8601Arb, checkedInBy: memberIdArb })
    .map(({ memberId, checkedInAt, checkedInBy }) => ({
      ticketId: randomUUID(),
      ticketCode: randomUUID(),
      orgId: event.orgId,
      eventId: event.eventId,
      memberId,
      status: 'CheckedIn' as TicketStatus,
      checkedInAt,
      checkedInBy,
      tenantId: event.tenantId,
    }));
}

// ─── Property 15: Check-In Idempotency ───────────────────────────────────────

describe('Property 15: Check-In Idempotency', () => {
  /**
   * P15-1: Re-checking in a ticket that is already CheckedIn always returns
   * the original checkedInAt timestamp — never creates a second record.
   */
  it(
    'P15-1: Re-checking in an already-CheckedIn ticket always returns the original checkedInAt',
    () => {
      fc.assert(
        fc.property(inProgressEventArb, memberIdArb, (event, actorId) => {
          // Start with a ticket that is already CheckedIn
          const originalTimestamp = new Date(Date.now() - 60_000).toISOString();
          const ticket: SimTicket = {
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            orgId: event.orgId,
            eventId: event.eventId,
            status: 'CheckedIn',
            checkedInAt: originalTimestamp,
            checkedInBy: actorId,
            tenantId: event.tenantId,
          };

          // Attempt a second check-in
          const result = simulateCheckIn(event, ticket, actorId, event.orgId, event.eventId);

          expect(result.success).toBe(true);
          if (result.success) {
            // Must return the ORIGINAL timestamp, not a new one
            expect(result.checkedInAt).toBe(originalTimestamp);
            expect(result.alreadyCheckedIn).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  /**
   * P15-2: First check-in always sets checkedInAt to a valid ISO 8601 UTC timestamp.
   */
  it('P15-2: First check-in always sets checkedInAt to a valid ISO 8601 UTC timestamp', () => {
    fc.assert(
      fc.property(inProgressEventArb, memberIdArb, (event, actorId) => {
        const ticket: SimTicket = {
          ticketId: randomUUID(),
          ticketCode: randomUUID(),
          orgId: event.orgId,
          eventId: event.eventId,
          status: 'Confirmed',
          tenantId: event.tenantId,
        };

        const result = simulateCheckIn(event, ticket, actorId, event.orgId, event.eventId);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.alreadyCheckedIn).toBe(false);
          // Must be a valid ISO 8601 string
          const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
          expect(result.checkedInAt).toMatch(iso8601Regex);
          // Must be a parseable date
          const parsed = new Date(result.checkedInAt);
          expect(isNaN(parsed.getTime())).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P15-3: Check-in on non-In_Progress event always rejected with 400.
   */
  it('P15-3: Check-in on non-In_Progress event always rejected with HTTP 400', () => {
    fc.assert(
      fc.property(
        nonInProgressStatusArb,
        orgIdArb,
        fc.integer({ min: 1, max: 500 }),
        memberIdArb,
        (status, orgId, capacity, actorId) => {
          const event: SimEvent = {
            eventId: randomUUID(),
            orgId,
            status,
            capacity,
            tenantId: orgId,
          };

          const ticket: SimTicket = {
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            orgId,
            eventId: event.eventId,
            status: 'Confirmed',
            tenantId: orgId,
          };

          const result = simulateCheckIn(event, ticket, actorId, orgId, event.eventId);

          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.statusCode).toBe(400);
            expect(result.errorCode).toBe('checkin.event_not_in_progress');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P15-4: Check-in with invalid/missing ticketCode always rejected with 404.
   * 404 is correct in this one case — ticket not found in org/event.
   */
  it('P15-4: Check-in with invalid ticketCode always rejected with HTTP 404', () => {
    fc.assert(
      fc.property(inProgressEventArb, memberIdArb, (event, actorId) => {
        // Pass undefined — simulates a ticketCode that does not exist in the DB
        const result = simulateCheckIn(event, undefined, actorId, event.orgId, event.eventId);

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.statusCode).toBe(404);
          expect(result.errorCode).toBe('checkin.ticket_not_found');
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P15-5: Two concurrent check-ins of the same ticket: second always returns alreadyCheckedIn=true.
   * Simulated by performing first check-in, applying its result, then performing second.
   */
  it(
    'P15-5: Second concurrent check-in of same ticket always returns alreadyCheckedIn=true',
    () => {
      fc.assert(
        fc.property(inProgressEventArb, memberIdArb, memberIdArb, (event, actor1, actor2) => {
          let ticket: SimTicket = {
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            orgId: event.orgId,
            eventId: event.eventId,
            status: 'Confirmed',
            tenantId: event.tenantId,
          };

          // First check-in (actor1)
          const first = simulateCheckIn(event, ticket, actor1, event.orgId, event.eventId);
          expect(first.success).toBe(true);
          if (first.success) {
            expect(first.alreadyCheckedIn).toBe(false);
          }

          // Apply first check-in
          ticket = applyCheckIn(ticket, first);

          // Second check-in (actor2 — simulates concurrent request arriving after first commits)
          const second = simulateCheckIn(event, ticket, actor2, event.orgId, event.eventId);

          expect(second.success).toBe(true);
          if (second.success) {
            expect(second.alreadyCheckedIn).toBe(true);
            // Must return the ORIGINAL timestamp set by actor1
            if (first.success) {
              expect(second.checkedInAt).toBe(first.checkedInAt);
            }
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  /**
   * P15-6: checkedInBy always equals the memberId from JWT context (actorId).
   */
  it('P15-6: checkedInBy always equals the memberId from the JWT context', () => {
    fc.assert(
      fc.property(inProgressEventArb, memberIdArb, (event, actorId) => {
        const ticket: SimTicket = {
          ticketId: randomUUID(),
          ticketCode: randomUUID(),
          orgId: event.orgId,
          eventId: event.eventId,
          status: 'Confirmed',
          tenantId: event.tenantId,
        };

        const result = simulateCheckIn(event, ticket, actorId, event.orgId, event.eventId);

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.checkedInBy).toBe(actorId);
        }
      }),
      { numRuns: 100 },
    );
  });
});
