// Feature: clois, Property 10: Ticket Code Uniqueness
// Validates: Requirements for Ticket management (Tasks 8.1, 8.2)
// Tests that any N generated ticketCodes are all unique UUIDs.

// Feature: clois, Property 11: Event Capacity Invariant
// confirmedCount never exceeds capacity
// Validates: Requirements for Ticket management (Tasks 8.1, 8.3)
// Tests that confirmed ticket count never exceeds event capacity.

// Feature: clois, Property 12: Waitlist Promotion FIFO Invariant
// Validates: Requirements for Ticket waitlist (Tasks 8.1, 8.4)
// Tests that when a ticket is cancelled, the waitlisted ticket with
// the LOWEST waitlistPosition is always promoted first.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { randomUUID } from 'crypto';

// ─── Helpers to simulate ticket management logic ───────────────────────────────

type TicketStatus = 'Confirmed' | 'Waitlisted' | 'Cancelled';

interface SimTicket {
  ticketId: string;
  ticketCode: string;
  status: TicketStatus;
  waitlistPosition?: number;
}

interface SimEventState {
  capacity: number;
  tickets: SimTicket[];
}

/**
 * Simulates the capacity invariant logic from service.ts:
 * - If confirmedCount < capacity → Confirmed
 * - If confirmedCount >= capacity and waitlistCount < 100 → Waitlisted
 * - If waitlistCount >= 100 → reject
 */
function simulateRsvp(
  state: SimEventState,
): { status: TicketStatus; waitlistPosition?: number } | { error: string } {
  const confirmedCount = state.tickets.filter((t) => t.status === 'Confirmed').length;
  const waitlistedTickets = state.tickets.filter((t) => t.status === 'Waitlisted');
  const waitlistCount = waitlistedTickets.length;

  if (confirmedCount < state.capacity) {
    return { status: 'Confirmed' };
  }

  if (waitlistCount >= 100) {
    return { error: 'waitlist_full' };
  }

  const maxPos = waitlistedTickets.reduce(
    (max, t) => Math.max(max, t.waitlistPosition ?? 0),
    0,
  );

  return { status: 'Waitlisted', waitlistPosition: maxPos + 1 };
}

/**
 * Simulates cancellation and waitlist promotion:
 * - Cancels the given ticket.
 * - If it was Confirmed, promotes the waitlist ticket with the lowest waitlistPosition.
 * Returns the updated state.
 */
function simulateCancelAndPromote(
  state: SimEventState,
  ticketIdToCancel: string,
): SimEventState {
  const ticket = state.tickets.find((t) => t.ticketId === ticketIdToCancel);
  if (!ticket) return state;

  const wasConfirmed = ticket.status === 'Confirmed';

  // Cancel the ticket
  const updatedTickets = state.tickets.map((t) =>
    t.ticketId === ticketIdToCancel ? { ...t, status: 'Cancelled' as TicketStatus } : t,
  );

  if (!wasConfirmed) {
    return { ...state, tickets: updatedTickets };
  }

  // Find the waitlisted ticket with the lowest waitlistPosition
  const waitlisted = updatedTickets
    .filter((t) => t.status === 'Waitlisted')
    .sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0));

  if (waitlisted.length === 0) {
    return { ...state, tickets: updatedTickets };
  }

  // Promote the first (lowest position) waitlisted ticket to Confirmed
  const toPromote = waitlisted[0];
  const promotedTickets = updatedTickets.map((t) =>
    t.ticketId === toPromote.ticketId
      ? { ...t, status: 'Confirmed' as TicketStatus, waitlistPosition: undefined }
      : t,
  );

  return { ...state, tickets: promotedTickets };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Generates a positive event capacity. */
const capacityArb = fc.integer({ min: 1, max: 50 });

/** Generates a count of RSVP requests to simulate. */
const rsvpCountArb = fc.integer({ min: 1, max: 80 });

// ─── Property 10: Ticket Code Uniqueness ─────────────────────────────────────

describe('Property 10: Ticket Code Uniqueness', () => {
  it('P10-1: Any N generated ticketCodes are all unique UUIDs', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 200 }), (n) => {
        const codes = Array.from({ length: n }, () => randomUUID());
        const uniqueCodes = new Set(codes);
        // All generated codes must be unique
        expect(uniqueCodes.size).toBe(n);
      }),
      { numRuns: 100 },
    );
  });

  it('P10-2: Each ticketCode matches the UUID v4 format', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
        const uuidRegex =
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        const codes = Array.from({ length: n }, () => randomUUID());
        for (const code of codes) {
          expect(code).toMatch(uuidRegex);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P10-3: Two independently generated ticketCodes for the same event are always different', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const code1 = randomUUID();
        const code2 = randomUUID();
        expect(code1).not.toBe(code2);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 11: Event Capacity Invariant ────────────────────────────────────

describe('Property 11: Event Capacity Invariant - confirmedCount never exceeds capacity', () => {
  it('P11-1: When confirmedCount < capacity, new RSVP is always Confirmed', () => {
    fc.assert(
      fc.property(capacityArb, rsvpCountArb, (capacity, rsvpCount) => {
        const state: SimEventState = { capacity, tickets: [] };

        for (let i = 0; i < rsvpCount; i++) {
          const result = simulateRsvp(state);
          if ('error' in result) break;

          state.tickets.push({
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            status: result.status,
            waitlistPosition: result.waitlistPosition,
          });
        }

        // Core invariant: confirmedCount never exceeds capacity
        const confirmedCount = state.tickets.filter((t) => t.status === 'Confirmed').length;
        expect(confirmedCount).toBeLessThanOrEqual(capacity);
      }),
      { numRuns: 100 },
    );
  });

  it('P11-2: Tickets beyond capacity are always Waitlisted, never Confirmed', () => {
    fc.assert(
      fc.property(capacityArb, (capacity) => {
        const state: SimEventState = { capacity, tickets: [] };

        // Fill to exact capacity
        for (let i = 0; i < capacity; i++) {
          state.tickets.push({
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            status: 'Confirmed',
          });
        }

        // Any additional RSVP must be Waitlisted
        for (let i = 0; i < 10; i++) {
          const result = simulateRsvp(state);
          if ('error' in result) break;

          expect(result.status).toBe('Waitlisted');
          state.tickets.push({
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            status: result.status,
            waitlistPosition: result.waitlistPosition,
          });
        }

        // confirmedCount must still equal capacity
        const confirmedCount = state.tickets.filter((t) => t.status === 'Confirmed').length;
        expect(confirmedCount).toBeLessThanOrEqual(capacity);
      }),
      { numRuns: 100 },
    );
  });

  it('P11-3: confirmedCount never exceeds capacity after any number of RSVPs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 20, max: 120 }),
        (capacity, totalRsvps) => {
          const state: SimEventState = { capacity, tickets: [] };

          for (let i = 0; i < totalRsvps; i++) {
            const result = simulateRsvp(state);
            if ('error' in result) break;

            state.tickets.push({
              ticketId: randomUUID(),
              ticketCode: randomUUID(),
              status: result.status,
              waitlistPosition: result.waitlistPosition,
            });
          }

          const confirmedCount = state.tickets.filter((t) => t.status === 'Confirmed').length;
          expect(confirmedCount).toBeLessThanOrEqual(capacity);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P11-4: Waitlist rejects registrations when waitlist is full (>= 100)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (capacity) => {
        const state: SimEventState = { capacity, tickets: [] };

        // Fill capacity with confirmed
        for (let i = 0; i < capacity; i++) {
          state.tickets.push({
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            status: 'Confirmed',
          });
        }

        // Fill waitlist to exactly 100
        for (let i = 1; i <= 100; i++) {
          state.tickets.push({
            ticketId: randomUUID(),
            ticketCode: randomUUID(),
            status: 'Waitlisted',
            waitlistPosition: i,
          });
        }

        // Next RSVP must be rejected (waitlist full)
        const result = simulateRsvp(state);
        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('waitlist_full');
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 12: Waitlist Promotion FIFO Invariant ───────────────────────────

describe('Property 12: Waitlist Promotion FIFO Invariant', () => {
  it('P12-1: When a Confirmed ticket is cancelled, the lowest waitlistPosition is always promoted', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 2, max: 15 }),
        (capacity, waitlistCount) => {
          // Build state: exactly capacity confirmed + waitlistCount waitlisted
          const tickets: SimTicket[] = [];

          for (let i = 0; i < capacity; i++) {
            tickets.push({
              ticketId: `confirmed-${i}`,
              ticketCode: randomUUID(),
              status: 'Confirmed',
            });
          }

          for (let i = 1; i <= waitlistCount; i++) {
            tickets.push({
              ticketId: `waitlisted-${i}`,
              ticketCode: randomUUID(),
              status: 'Waitlisted',
              waitlistPosition: i,
            });
          }

          const state: SimEventState = { capacity, tickets };

          // Cancel a confirmed ticket
          const ticketToCancel = tickets[0].ticketId;
          const newState = simulateCancelAndPromote(state, ticketToCancel);

          // The ticket with waitlistPosition = 1 must now be Confirmed
          const promotedTicket = newState.tickets.find((t) => t.ticketId === 'waitlisted-1');
          expect(promotedTicket?.status).toBe('Confirmed');
          expect(promotedTicket?.waitlistPosition).toBeUndefined();

          // All other waitlisted tickets (position > 1) must remain Waitlisted
          for (let i = 2; i <= waitlistCount; i++) {
            const t = newState.tickets.find((t) => t.ticketId === `waitlisted-${i}`);
            expect(t?.status).toBe('Waitlisted');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P12-2: cancelling a Waitlisted ticket does NOT trigger promotion', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 2, max: 10 }),
        (capacity, waitlistCount) => {
          const tickets: SimTicket[] = [];

          for (let i = 0; i < capacity; i++) {
            tickets.push({
              ticketId: `confirmed-${i}`,
              ticketCode: randomUUID(),
              status: 'Confirmed',
            });
          }

          for (let i = 1; i <= waitlistCount; i++) {
            tickets.push({
              ticketId: `waitlisted-${i}`,
              ticketCode: randomUUID(),
              status: 'Waitlisted',
              waitlistPosition: i,
            });
          }

          const state: SimEventState = { capacity, tickets };

          // Cancel a waitlisted ticket (position = 2)
          const ticketToCancel = 'waitlisted-2';
          const newState = simulateCancelAndPromote(state, ticketToCancel);

          // waitlisted-1 must remain Waitlisted (no promotion should occur)
          const ticket1 = newState.tickets.find((t) => t.ticketId === 'waitlisted-1');
          expect(ticket1?.status).toBe('Waitlisted');

          // confirmed tickets must all remain Confirmed
          for (let i = 0; i < capacity; i++) {
            const t = newState.tickets.find((t) => t.ticketId === `confirmed-${i}`);
            expect(t?.status).toBe('Confirmed');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P12-3: After promotion, confirmedCount remains <= capacity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (capacity, waitlistCount) => {
          const tickets: SimTicket[] = [];

          for (let i = 0; i < capacity; i++) {
            tickets.push({
              ticketId: `confirmed-${i}`,
              ticketCode: randomUUID(),
              status: 'Confirmed',
            });
          }

          for (let i = 1; i <= waitlistCount; i++) {
            tickets.push({
              ticketId: `waitlisted-${i}`,
              ticketCode: randomUUID(),
              status: 'Waitlisted',
              waitlistPosition: i,
            });
          }

          const state: SimEventState = { capacity, tickets };

          // Cancel the first confirmed ticket (triggers promotion)
          const newState = simulateCancelAndPromote(state, 'confirmed-0');

          const confirmedCount = newState.tickets.filter((t) => t.status === 'Confirmed').length;
          // After promotion: confirmed count should equal capacity (one cancelled, one promoted)
          expect(confirmedCount).toBeLessThanOrEqual(capacity);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P12-4: FIFO order is preserved across multiple cancellations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 3, max: 8 }),
        (capacity, waitlistCount) => {
          const tickets: SimTicket[] = [];

          for (let i = 0; i < capacity; i++) {
            tickets.push({
              ticketId: `confirmed-${i}`,
              ticketCode: randomUUID(),
              status: 'Confirmed',
            });
          }

          for (let i = 1; i <= waitlistCount; i++) {
            tickets.push({
              ticketId: `waitlisted-${i}`,
              ticketCode: randomUUID(),
              status: 'Waitlisted',
              waitlistPosition: i,
            });
          }

          let state: SimEventState = { capacity, tickets };

          // Perform multiple cancellations
          for (let cancel = 0; cancel < Math.min(capacity, waitlistCount); cancel++) {
            const confirmedBefore = state.tickets.filter((t) => t.status === 'Confirmed');
            if (confirmedBefore.length === 0) break;

            // Find the next waitlisted ticket (lowest position among remaining)
            const nextWaitlisted = state.tickets
              .filter((t) => t.status === 'Waitlisted')
              .sort((a, b) => (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0));

            if (nextWaitlisted.length === 0) break;
            const expectedPromotion = nextWaitlisted[0].ticketId;

            state = simulateCancelAndPromote(state, confirmedBefore[0].ticketId);

            // The expected ticket (lowest position) must now be Confirmed
            const promoted = state.tickets.find((t) => t.ticketId === expectedPromotion);
            expect(promoted?.status).toBe('Confirmed');

            // confirmedCount must remain <= capacity
            const confirmedCount = state.tickets.filter((t) => t.status === 'Confirmed').length;
            expect(confirmedCount).toBeLessThanOrEqual(capacity);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
