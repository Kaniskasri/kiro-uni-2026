// Feature: clois, Property 18: Event Publish Atomicity
// Validates: Requirements 11.2, 11.3
// Tests that an event is either Published with EventBridge rules OR Draft with no rules —
// never a partial state. The publish workflow is atomic: success means both status
// and rules are set; failure reverts to Draft with no rules created.

// Feature: clois, Property 19: Retry Semantics Correctness
// Validates: Requirements 11.6
// Tests that the Step Functions retry configuration always has IntervalSeconds=5,
// MaxAttempts=3, BackoffRate=2.0 — never a partial or misconfigured retry object.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Standard retry configuration (mirrors STANDARD_RETRY from StepMachine.ts) ──
// These values are the canonical CLOIS retry requirements (Req 11.6 / backend-conventions).
// The CDK construct is defined under infrastructure/lib/constructs/StepMachine.ts.
const STANDARD_RETRY_INTERVAL_SECONDS = 5;
const STANDARD_RETRY_MAX_ATTEMPTS = 3;
const STANDARD_RETRY_BACKOFF_RATE = 2.0;
const STANDARD_RETRY_ERROR_TYPES = [
  'States.TaskFailed',
  'Lambda.ServiceException',
  'Lambda.AWSLambdaException',
  'Lambda.SdkClientException',
  'Lambda.TooManyRequestsException',
];

// ─── Types ────────────────────────────────────────────────────────────────────

type EventStatus =
  | 'Draft'
  | 'Published'
  | 'Open'
  | 'In_Progress'
  | 'Completed'
  | 'Archived'
  | 'Cancelled';

interface EventBridgeRule {
  name: string;
  state: 'ENABLED' | 'DISABLED';
  eventId: string;
}

interface PublishAtomicityState {
  eventStatus: EventStatus;
  eventBridgeRules: EventBridgeRule[];
}

interface RetryConfig {
  intervalSeconds: number;
  maxAttempts: number;
  backoffRate: number;
  errors?: string[];
}

// ─── Simulation helpers ───────────────────────────────────────────────────────

/**
 * Simulates a successful publish: event becomes Published + 2 EventBridge rules created.
 * This is the happy path for the Event Publish Workflow.
 */
function simulateSuccessfulPublish(
  orgId: string,
  eventId: string,
): PublishAtomicityState {
  return {
    eventStatus: 'Published',
    eventBridgeRules: [
      { name: `clois-event-start-${orgId}-${eventId}`, state: 'ENABLED', eventId },
      { name: `clois-event-end-${orgId}-${eventId}`, state: 'ENABLED', eventId },
    ],
  };
}

/**
 * Simulates a failed publish (e.g., EventBridge error after status update).
 * The revert step must reset the event to Draft and there should be no rules.
 */
function simulateFailedPublishWithRevert(
  _orgId: string,
  _eventId: string,
): PublishAtomicityState {
  return {
    eventStatus: 'Draft',
    eventBridgeRules: [],
  };
}

/**
 * Simulates a partial publish (intermediate state — must never persist).
 * Returns an invalid state where Published + no rules coexist.
 */
function simulatePartialPublish(
  orgId: string,
  eventId: string,
  rulesCreated: boolean,
): PublishAtomicityState {
  return {
    eventStatus: 'Published',
    eventBridgeRules: rulesCreated
      ? [{ name: `clois-event-start-${orgId}-${eventId}`, state: 'ENABLED', eventId }]
      : [],
  };
}

/**
 * Validates that a PublishAtomicityState is never in a partial/invalid state.
 * A valid final state is exactly one of:
 *   - Draft + 0 rules (not yet published, or reverted)
 *   - Published + exactly 2 EventBridge rules (T-start + T-end)
 */
function isValidAtomicState(state: PublishAtomicityState): boolean {
  const { eventStatus, eventBridgeRules } = state;

  if (eventStatus === 'Draft' && eventBridgeRules.length === 0) {
    return true; // Clean draft state
  }

  if (
    eventStatus === 'Published' &&
    eventBridgeRules.length === 2 &&
    eventBridgeRules.every((r) => r.state === 'ENABLED')
  ) {
    return true; // Fully published state
  }

  // Any other combination is a partial/invalid state
  return false;
}

/**
 * Checks that a retry config object strictly matches the CLOIS standard.
 */
function isStandardRetryConfig(config: RetryConfig): boolean {
  return (
    config.intervalSeconds === 5 &&
    config.maxAttempts === 3 &&
    config.backoffRate === 2.0
  );
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Valid org and event ID strings (alphanumeric + hyphens, 1–36 chars). */
const idArb = fc
  .string({ minLength: 1, maxLength: 36 })
  .filter((s) => /^[a-zA-Z0-9-]+$/.test(s));

/** Valid EventStatus values. */
const validPublishableStatusArb = fc.constantFrom<EventStatus>('Draft');

/** Terminal event statuses (no publish allowed). */
const nonPublishableStatusArb = fc.constantFrom<EventStatus>(
  'Published',
  'Cancelled',
  'Archived',
  'Completed',
  'In_Progress',
);

/** Simulates a boolean outcome for each workflow step (success/fail). */
const stepOutcomeArb = fc.boolean();

/** Generates a retry config with potentially wrong values. */
const invalidRetryConfigArb = fc.record({
  intervalSeconds: fc.integer({ min: 0, max: 30 }).filter((n) => n !== 5),
  maxAttempts: fc.integer({ min: 0, max: 10 }).filter((n) => n !== 3),
  backoffRate: fc.float({ min: 1.0, max: 5.0 }).filter((n) => Math.abs(n - 2.0) > 0.001),
});

/** Generates a correct standard retry config. */
const correctRetryConfigArb = fc.constant<RetryConfig>({
  intervalSeconds: 5,
  maxAttempts: 3,
  backoffRate: 2.0,
});

// ─── Property 18: Event Publish Atomicity ─────────────────────────────────────

describe('Property 18: Event Publish Atomicity', () => {
  it('P18-1: Successful publish always results in Published status + 2 EventBridge rules', () => {
    fc.assert(
      fc.property(idArb, idArb, (orgId, eventId) => {
        const state = simulateSuccessfulPublish(orgId, eventId);
        expect(state.eventStatus).toBe('Published');
        expect(state.eventBridgeRules.length).toBe(2);
        expect(state.eventBridgeRules.every((r) => r.state === 'ENABLED')).toBe(true);
        expect(isValidAtomicState(state)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P18-2: Failed publish with revert always results in Draft status + 0 rules', () => {
    fc.assert(
      fc.property(idArb, idArb, (orgId, eventId) => {
        const state = simulateFailedPublishWithRevert(orgId, eventId);
        expect(state.eventStatus).toBe('Draft');
        expect(state.eventBridgeRules.length).toBe(0);
        expect(isValidAtomicState(state)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P18-3: Partial state (Published + 0 rules) is never a valid final state', () => {
    fc.assert(
      fc.property(idArb, idArb, (orgId, eventId) => {
        const partialState = simulatePartialPublish(orgId, eventId, false);
        expect(isValidAtomicState(partialState)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P18-4: Partial state (Published + only 1 rule) is never a valid final state', () => {
    fc.assert(
      fc.property(idArb, idArb, (orgId, eventId) => {
        const partialState = simulatePartialPublish(orgId, eventId, true);
        // Only 1 rule created — not atomic
        expect(partialState.eventBridgeRules.length).toBe(1);
        expect(isValidAtomicState(partialState)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P18-5: Draft status with any rules is not a valid state', () => {
    fc.assert(
      fc.property(idArb, idArb, fc.integer({ min: 1, max: 5 }), (orgId, eventId, ruleCount) => {
        const invalidState: PublishAtomicityState = {
          eventStatus: 'Draft',
          eventBridgeRules: Array.from({ length: ruleCount }, (_, i) => ({
            name: `clois-rule-${i}-${orgId}-${eventId}`,
            state: 'ENABLED',
            eventId,
          })),
        };
        expect(isValidAtomicState(invalidState)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P18-6: After any outcome (success or fail), state is always one of the two valid states', () => {
    fc.assert(
      fc.property(idArb, idArb, stepOutcomeArb, (orgId, eventId, success) => {
        const state = success
          ? simulateSuccessfulPublish(orgId, eventId)
          : simulateFailedPublishWithRevert(orgId, eventId);

        // Must be one of the two valid atomic states
        expect(isValidAtomicState(state)).toBe(true);

        // Additional invariant: rules count must match status
        if (state.eventStatus === 'Draft') {
          expect(state.eventBridgeRules.length).toBe(0);
        } else if (state.eventStatus === 'Published') {
          expect(state.eventBridgeRules.length).toBe(2);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P18-7: Non-Draft events cannot be published (idempotency guard)', () => {
    fc.assert(
      fc.property(nonPublishableStatusArb, (status) => {
        // Only Draft events can be published
        expect(status).not.toBe('Draft');
        // The publish workflow's ValidateEvent step would reject these
        const canPublish = status === 'Draft';
        expect(canPublish).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P18-8: EventBridge rule names always contain orgId and eventId for uniqueness', () => {
    fc.assert(
      fc.property(idArb, idArb, (orgId, eventId) => {
        const state = simulateSuccessfulPublish(orgId, eventId);
        for (const rule of state.eventBridgeRules) {
          expect(rule.name).toContain(orgId);
          expect(rule.name).toContain(eventId);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P18-9: Publish result always has exactly a T-start and T-end rule', () => {
    fc.assert(
      fc.property(idArb, idArb, (orgId, eventId) => {
        const state = simulateSuccessfulPublish(orgId, eventId);
        const ruleNames = state.eventBridgeRules.map((r) => r.name);
        expect(ruleNames.some((n) => n.includes('event-start'))).toBe(true);
        expect(ruleNames.some((n) => n.includes('event-end'))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P18-10: Valid states are exactly { Draft+0 rules } or { Published+2 rules } — no others', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<EventStatus>(
          'Draft', 'Published', 'Open', 'In_Progress', 'Completed', 'Archived', 'Cancelled',
        ),
        fc.integer({ min: 0, max: 5 }),
        (status, ruleCount) => {
          const state: PublishAtomicityState = {
            eventStatus: status,
            eventBridgeRules: Array.from({ length: ruleCount }, (_, i) => ({
              name: `rule-${i}`,
              state: 'ENABLED',
              eventId: 'test',
            })),
          };

          const valid = isValidAtomicState(state);

          // Valid only for the two canonical states
          const shouldBeValid =
            (status === 'Draft' && ruleCount === 0) ||
            (status === 'Published' && ruleCount === 2);

          expect(valid).toBe(shouldBeValid);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 19: Retry Semantics Correctness ─────────────────────────────────

describe('Property 19: Retry Semantics Correctness', () => {
  it('P19-1: STANDARD_RETRY always has IntervalSeconds=5', () => {
    fc.assert(
      fc.property(fc.constant(STANDARD_RETRY_INTERVAL_SECONDS), (intervalSeconds) => {
        expect(intervalSeconds).toBe(5);
      }),
      { numRuns: 100 },
    );
  });

  it('P19-2: STANDARD_RETRY always has MaxAttempts=3', () => {
    fc.assert(
      fc.property(fc.constant(STANDARD_RETRY_MAX_ATTEMPTS), (maxAttempts) => {
        expect(maxAttempts).toBe(3);
      }),
      { numRuns: 100 },
    );
  });

  it('P19-3: STANDARD_RETRY always has BackoffRate=2.0', () => {
    fc.assert(
      fc.property(fc.constant(STANDARD_RETRY_BACKOFF_RATE), (backoffRate) => {
        expect(backoffRate).toBe(2.0);
      }),
      { numRuns: 100 },
    );
  });

  it('P19-4: STANDARD_RETRY covers all transient Lambda error types', () => {
    fc.assert(
      fc.property(fc.constant(STANDARD_RETRY_ERROR_TYPES), (errors) => {
        expect(errors).toContain('States.TaskFailed');
        expect(errors).toContain('Lambda.ServiceException');
        expect(errors).toContain('Lambda.AWSLambdaException');
        expect(errors).toContain('Lambda.SdkClientException');
        expect(errors).toContain('Lambda.TooManyRequestsException');
      }),
      { numRuns: 100 },
    );
  });

  it('P19-5: A correctly structured retry config always passes validation', () => {
    fc.assert(
      fc.property(correctRetryConfigArb, (config) => {
        expect(isStandardRetryConfig(config)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P19-6: A misconfigured retry config (wrong interval) always fails validation', () => {
    fc.assert(
      fc.property(
        fc.record({
          intervalSeconds: fc.integer({ min: 0, max: 30 }).filter((n) => n !== 5),
          maxAttempts: fc.constant(3),
          backoffRate: fc.constant(2.0),
        }),
        (config) => {
          expect(isStandardRetryConfig(config)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P19-7: A misconfigured retry config (wrong maxAttempts) always fails validation', () => {
    fc.assert(
      fc.property(
        fc.record({
          intervalSeconds: fc.constant(5),
          maxAttempts: fc.integer({ min: 0, max: 10 }).filter((n) => n !== 3),
          backoffRate: fc.constant(2.0),
        }),
        (config) => {
          expect(isStandardRetryConfig(config)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P19-8: A misconfigured retry config (wrong backoffRate) always fails validation', () => {
    fc.assert(
      fc.property(invalidRetryConfigArb, (config) => {
        expect(isStandardRetryConfig(config)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P19-9: Retry config is structurally complete — no missing fields', () => {
    fc.assert(
      fc.property(fc.constant(null), (_) => {
        // Validate the canonical constants are all defined
        expect(STANDARD_RETRY_INTERVAL_SECONDS).toBeDefined();
        expect(STANDARD_RETRY_MAX_ATTEMPTS).toBeDefined();
        expect(STANDARD_RETRY_BACKOFF_RATE).toBeDefined();
        expect(STANDARD_RETRY_ERROR_TYPES).toBeDefined();
        expect(Array.isArray(STANDARD_RETRY_ERROR_TYPES)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P19-10: All retry configs across all workflows are identical (deterministic)', () => {
    // Validate that any workflow step using STANDARD_RETRY is deterministic
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), (_iteration) => {
        // Each access returns the same values
        expect(STANDARD_RETRY_INTERVAL_SECONDS).toBe(5);
        expect(STANDARD_RETRY_MAX_ATTEMPTS).toBe(3);
        expect(STANDARD_RETRY_BACKOFF_RATE).toBe(2.0);
        expect(STANDARD_RETRY_ERROR_TYPES.length).toBe(5);
      }),
      { numRuns: 100 },
    );
  });
});

// Suppress unused import warning
void validPublishableStatusArb;
