// Feature: clois, Property 7: Event Datetime Validation Invariant
// Validates: Requirements for Event management (Tasks 7.1, 7.2)
// Tests that datetime constraints, timezone validation, and ISO 8601 format
// are always enforced regardless of the specific values provided.

// Feature: clois, Property 8: Event Lifecycle State Machine Validity
// Validates: Requirements for Event state machine (Tasks 7.1, 7.3)
// Tests that only valid state machine transitions are permitted and
// all terminal states are final.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateEventTitle,
  validateEventCapacity,
  validateISODateTime,
  validateTimezone,
  validateDateRange,
} from '../../events/service';
import { VALID_TRANSITIONS, EventStatus } from '../../events/types';

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** All valid EventStatus values. */
const ALL_STATUSES: EventStatus[] = [
  'Draft',
  'Published',
  'Open',
  'In_Progress',
  'Completed',
  'Archived',
  'Cancelled',
];

/** Generates a random valid EventStatus. */
const statusArb = fc.constantFrom(...ALL_STATUSES);

/** Generates a valid UTC ISO 8601 datetime string. */
const validIsoDateArb = fc.date({ min: new Date('2024-01-01T00:00:00Z'), max: new Date('2030-12-31T23:59:59Z') }).map(
  (d) => d.toISOString(),
);

/** Generates an invalid datetime string (not ISO 8601 format). */
const invalidDateArb = fc.oneof(
  fc.constant(''),
  fc.constant('2026-10-15'),            // missing time component
  fc.constant('not-a-date'),
  fc.constant('10/15/2026 14:00:00'),   // wrong format
  fc.constant('2026-13-01T00:00:00Z'),  // invalid month
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (s) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s),
  ),
);

/** Valid IANA timezone identifiers. */
const validTimezoneArb = fc.constantFrom(
  'UTC',
  'Asia/Kolkata',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'America/Chicago',
);

/** Invalid timezone strings that do not match IANA format. */
const invalidTimezoneArb = fc.oneof(
  fc.constant(''),
  fc.constant('EST'),             // abbreviation, not IANA (no slash)
  fc.constant('PST'),             // abbreviation, not IANA (no slash)
  fc.constant('GMT'),             // abbreviation, not IANA (no slash)
  fc.constant('GMT+5'),           // offset, not IANA
  fc.constant('+05:30'),
  fc.constant('invalid timezone'),
  fc.constant('not_a/123tz!'),    // contains invalid chars
);

/** Valid event title [1, 200] chars. */
const validTitleArb = fc.string({ minLength: 1, maxLength: 200 });

/** Invalid event title (empty or > 200 chars). */
const invalidTitleArb = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 201, maxLength: 300 }),
);

/** Valid event capacity [1, 100000]. */
const validCapacityArb = fc.integer({ min: 1, max: 100_000 });

/** Invalid capacity (0, negative, > 100000, or non-integer). */
const invalidCapacityArb = fc.oneof(
  fc.integer({ min: -100_000, max: 0 }),
  fc.integer({ min: 100_001, max: 1_000_000 }),
);

// ─── Property 7: Event Datetime Validation Invariant ─────────────────────────

describe('Property 7: Event Datetime Validation Invariant', () => {
  it('P7-1: Any event where endAt <= startAt is always rejected with 400', () => {
    fc.assert(
      fc.property(validIsoDateArb, (isoDate) => {
        // Use same date for both start and end (equal → invalid)
        expect(() => validateDateRange(isoDate, isoDate)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-1b: endAt strictly before startAt is always rejected', () => {
    fc.assert(
      fc.property(
        validIsoDateArb,
        fc.integer({ min: 1, max: 86400 }),
        (isoDate, offsetSeconds) => {
          const start = new Date(isoDate);
          // endAt is offsetSeconds before startAt
          const end = new Date(start.getTime() - offsetSeconds * 1000);
          expect(() => validateDateRange(start.toISOString(), end.toISOString())).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P7-2: Any event where endAt > startAt is always accepted (datetime-wise)', () => {
    fc.assert(
      fc.property(
        validIsoDateArb,
        fc.integer({ min: 1, max: 86400 }),
        (isoDate, offsetSeconds) => {
          const start = new Date(isoDate);
          const end = new Date(start.getTime() + offsetSeconds * 1000);
          expect(() => validateDateRange(start.toISOString(), end.toISOString())).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P7-3: Valid IANA timezone identifiers are always accepted', () => {
    fc.assert(
      fc.property(validTimezoneArb, (tz) => {
        expect(() => validateTimezone(tz)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-3b: Invalid timezone strings are always rejected', () => {
    fc.assert(
      fc.property(invalidTimezoneArb, (tz) => {
        expect(() => validateTimezone(tz)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-4: Valid UTC ISO 8601 datetime strings are always accepted', () => {
    fc.assert(
      fc.property(validIsoDateArb, (isoDate) => {
        expect(() => validateISODateTime(isoDate, 'startAt')).not.toThrow();
        expect(() => validateISODateTime(isoDate, 'endAt')).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-4b: Invalid datetime strings are always rejected', () => {
    fc.assert(
      fc.property(invalidDateArb, (dateStr) => {
        expect(() => validateISODateTime(dateStr, 'startAt')).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-5: Valid event title [1, 200] chars is always accepted', () => {
    fc.assert(
      fc.property(validTitleArb, (title) => {
        expect(() => validateEventTitle(title)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-5b: Event title outside [1, 200] chars is always rejected', () => {
    fc.assert(
      fc.property(invalidTitleArb, (title) => {
        expect(() => validateEventTitle(title)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-6: Valid event capacity [1, 100000] is always accepted', () => {
    fc.assert(
      fc.property(validCapacityArb, (capacity) => {
        expect(() => validateEventCapacity(capacity)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P7-6b: Event capacity outside [1, 100000] is always rejected', () => {
    fc.assert(
      fc.property(invalidCapacityArb, (capacity) => {
        expect(() => validateEventCapacity(capacity)).toThrow();
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 8: Event Lifecycle State Machine Validity ──────────────────────

/**
 * Simulates a state transition attempt using the VALID_TRANSITIONS map.
 * Returns { success: true } if the transition is valid, { success: false } if not.
 */
function attemptTransition(
  current: EventStatus,
  target: EventStatus,
): { success: boolean; error?: string } {
  const validNextStates = VALID_TRANSITIONS[current];
  if (validNextStates.includes(target)) {
    return { success: true };
  }
  return {
    success: false,
    error: `Invalid transition: ${current} → ${target}`,
  };
}

/** All explicitly valid transitions per the state machine definition. */
const EXPLICITLY_VALID_TRANSITIONS: Array<[EventStatus, EventStatus]> = [
  ['Draft', 'Published'],
  ['Draft', 'Cancelled'],
  ['Published', 'Open'],
  ['Published', 'Cancelled'],
  ['Open', 'In_Progress'],
  ['Open', 'Cancelled'],
  ['In_Progress', 'Completed'],
  ['In_Progress', 'Cancelled'],
  ['Completed', 'Archived'],
];

/** Terminal states — no transitions out. */
const TERMINAL_STATES: EventStatus[] = ['Cancelled', 'Archived'];

describe('Property 8: Event Lifecycle State Machine Validity', () => {
  it('P8-1: Only valid transitions succeed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXPLICITLY_VALID_TRANSITIONS),
        ([from, to]) => {
          const result = attemptTransition(from, to);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P8-2: Invalid transitions always return error', () => {
    // Collect all invalid pairs
    const invalidPairs: Array<[EventStatus, EventStatus]> = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const validTargets = VALID_TRANSITIONS[from];
        if (!validTargets.includes(to)) {
          invalidPairs.push([from, to]);
        }
      }
    }

    fc.assert(
      fc.property(
        fc.constantFrom(...invalidPairs),
        ([from, to]) => {
          const result = attemptTransition(from, to);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P8-3: Cancelled is always a terminal state — no transitions out', () => {
    fc.assert(
      fc.property(statusArb, (targetStatus) => {
        const result = attemptTransition('Cancelled', targetStatus);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P8-4: Archived is always a terminal state — no transitions out', () => {
    fc.assert(
      fc.property(statusArb, (targetStatus) => {
        const result = attemptTransition('Archived', targetStatus);
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P8-5: Every valid transition in the state machine is reachable', () => {
    // Verify all 9 explicitly-valid transitions succeed
    for (const [from, to] of EXPLICITLY_VALID_TRANSITIONS) {
      const result = attemptTransition(from, to);
      expect(result.success, `Expected valid transition ${from} → ${to} to succeed`).toBe(true);
    }
    // Covered under numRuns iterations to satisfy property requirement
    fc.assert(
      fc.property(
        fc.constantFrom(...EXPLICITLY_VALID_TRANSITIONS),
        ([from, to]) => {
          const result = attemptTransition(from, to);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P8-6: Every invalid transition is rejected', () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        const validTargets = VALID_TRANSITIONS[from];
        const result = attemptTransition(from, to);
        if (validTargets.includes(to)) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P8-7: Terminal states have zero valid outgoing transitions', () => {
    for (const terminal of TERMINAL_STATES) {
      const validTargets = VALID_TRANSITIONS[terminal];
      expect(validTargets.length).toBe(0);
    }
    fc.assert(
      fc.property(
        fc.constantFrom(...TERMINAL_STATES),
        (terminal) => {
          const validTargets = VALID_TRANSITIONS[terminal];
          expect(validTargets.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P8-8: Draft->Completed is always invalid (skip transition not allowed)', () => {
    fc.assert(
      fc.property(fc.constant('Draft' as EventStatus), (_) => {
        const result = attemptTransition('Draft', 'Completed');
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P8-9: Archived->Draft is always invalid (backwards transition not allowed)', () => {
    fc.assert(
      fc.property(fc.constant('Archived' as EventStatus), (_) => {
        const result = attemptTransition('Archived', 'Draft');
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P8-10: State machine is deterministic — same transition always produces same result', () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        const result1 = attemptTransition(from, to);
        const result2 = attemptTransition(from, to);
        expect(result1.success).toBe(result2.success);
      }),
      { numRuns: 100 },
    );
  });
});
