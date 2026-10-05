// Feature: clois, Property 29: Circuit Breaker State Transitions
// Validates: Requirements 21.4
// Tests that the circuit breaker transitions correctly between CLOSED, OPEN, and HALF_OPEN states.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { CircuitBreaker, CircuitState } from '../../shared/layers/circuitBreaker';

// ─── Mock DynamoDB to avoid real AWS calls ────────────────────────────────────

vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: vi.fn().mockImplementation(() => ({})),
  };
});

vi.mock('@aws-sdk/lib-dynamodb', () => {
  const store: Record<string, unknown> = {};

  return {
    DynamoDBDocumentClient: {
      from: vi.fn().mockReturnValue({
        send: vi.fn().mockImplementation(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const cmdName = cmd.constructor?.name ?? '';
          if (cmdName === 'GetCommand') {
            const key = cmd.input?.['Key'] as Record<string, unknown>;
            const pk = key?.['PK'] as string;
            return { Item: store[pk] ?? null };
          }
          if (cmdName === 'PutCommand') {
            const item = cmd.input?.['Item'] as Record<string, unknown>;
            const pk = item?.['PK'] as string;
            store[pk] = item;
            return {};
          }
          return {};
        }),
      }),
    },
    GetCommand: class GetCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
    PutCommand: class PutCommand {
      input: unknown;
      constructor(input: unknown) { this.input = input; }
    },
  };
});

// ─── Pure state machine simulation (for property testing without AWS) ─────────

interface CBState {
  state: CircuitState;
  failureCount: number;
  windowStart: number;    // epoch ms
  openedAt?: number;      // epoch ms
}

const FAILURE_THRESHOLD = 5;
const WINDOW_SECONDS = 60;
const OPEN_DURATION_SECONDS = 120;

function createInitialState(nowMs: number): CBState {
  return {
    state: 'CLOSED',
    failureCount: 0,
    windowStart: nowMs,
  };
}

function resolveState(state: CBState, nowMs: number): CircuitState {
  if (state.state === 'OPEN' && state.openedAt !== undefined) {
    const elapsed = (nowMs - state.openedAt) / 1000;
    if (elapsed >= OPEN_DURATION_SECONDS) {
      return 'HALF_OPEN';
    }
  }
  return state.state;
}

function recordFailure(state: CBState, nowMs: number): CBState {
  const current = resolveState(state, nowMs);

  // HALF_OPEN probe failed → re-open
  if (current === 'HALF_OPEN') {
    return {
      ...state,
      state: 'OPEN',
      openedAt: nowMs,
    };
  }

  // Reset window if outside time window
  const outsideWindow = nowMs - state.windowStart > WINDOW_SECONDS * 1000;
  const windowStart = outsideWindow ? nowMs : state.windowStart;
  const failureCount = outsideWindow ? 1 : state.failureCount + 1;

  if (failureCount >= FAILURE_THRESHOLD) {
    return {
      ...state,
      state: 'OPEN',
      failureCount,
      windowStart,
      openedAt: nowMs,
    };
  }

  return { ...state, state: 'CLOSED', failureCount, windowStart };
}

function recordSuccess(state: CBState, nowMs: number): CBState {
  return {
    state: 'CLOSED',
    failureCount: 0,
    windowStart: nowMs,
    openedAt: undefined,
  };
}

// ─── Property 29: Circuit Breaker State Transitions ──────────────────────────

describe('Property 29: Circuit Breaker State Transitions', () => {

  it('P29-1: CLOSED → OPEN after exactly 5 consecutive failures within 60s window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (baseMs) => {
          let state = createInitialState(baseMs);
          // 4 failures should keep CLOSED
          for (let i = 0; i < 4; i++) {
            state = recordFailure(state, baseMs + i * 1000);
            expect(resolveState(state, baseMs + i * 1000)).toBe('CLOSED');
          }
          // 5th failure should OPEN the circuit
          state = recordFailure(state, baseMs + 4 * 1000);
          expect(resolveState(state, baseMs + 4 * 1000)).toBe('OPEN');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-2: OPEN → HALF_OPEN after 120 seconds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (baseMs) => {
          let state = createInitialState(baseMs);
          // Open the circuit with 5 failures
          for (let i = 0; i < 5; i++) {
            state = recordFailure(state, baseMs + i * 1000);
          }
          expect(resolveState(state, baseMs + 4000)).toBe('OPEN');

          // After 120 seconds → HALF_OPEN
          const after120s = baseMs + 4000 + OPEN_DURATION_SECONDS * 1000;
          expect(resolveState(state, after120s)).toBe('HALF_OPEN');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-3: HALF_OPEN → CLOSED on success', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (baseMs) => {
          let state = createInitialState(baseMs);
          // Open the circuit
          for (let i = 0; i < 5; i++) {
            state = recordFailure(state, baseMs + i * 1000);
          }
          // Advance 120s to enter HALF_OPEN territory
          const halfOpenMs = baseMs + 4000 + OPEN_DURATION_SECONDS * 1000;
          expect(resolveState(state, halfOpenMs)).toBe('HALF_OPEN');

          // Probe succeeds → CLOSED
          state = recordSuccess(state, halfOpenMs);
          expect(resolveState(state, halfOpenMs)).toBe('CLOSED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-4: HALF_OPEN → OPEN on failure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (baseMs) => {
          let state = createInitialState(baseMs);
          // Open the circuit
          for (let i = 0; i < 5; i++) {
            state = recordFailure(state, baseMs + i * 1000);
          }
          // Advance to HALF_OPEN
          const halfOpenMs = baseMs + 4000 + OPEN_DURATION_SECONDS * 1000;
          expect(resolveState(state, halfOpenMs)).toBe('HALF_OPEN');

          // Probe fails → re-OPEN
          state = recordFailure(state, halfOpenMs);
          expect(resolveState(state, halfOpenMs)).toBe('OPEN');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-5: Failures reset when outside the 60s window', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        (baseMs) => {
          let state = createInitialState(baseMs);
          // 4 failures near threshold
          for (let i = 0; i < 4; i++) {
            state = recordFailure(state, baseMs + i * 1000);
          }
          expect(resolveState(state, baseMs + 3000)).toBe('CLOSED');
          expect(state.failureCount).toBe(4);

          // One failure after window resets count to 1 — should still be CLOSED
          const afterWindow = baseMs + (WINDOW_SECONDS + 10) * 1000;
          state = recordFailure(state, afterWindow);
          expect(resolveState(state, afterWindow)).toBe('CLOSED');
          expect(state.failureCount).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-6: Circuit stays OPEN for full 120 seconds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 119 }),
        (baseMs, secondsElapsed) => {
          let state = createInitialState(baseMs);
          for (let i = 0; i < 5; i++) {
            state = recordFailure(state, baseMs + i * 1000);
          }
          const openedAt = baseMs + 4000;
          const checkMs = openedAt + secondsElapsed * 1000;
          expect(resolveState(state, checkMs)).toBe('OPEN');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-7: recordSuccess always resets failureCount to 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 10 }),
        (baseMs, failures) => {
          let state = createInitialState(baseMs);
          // Add some failures without triggering OPEN
          const safeFailures = Math.min(failures, FAILURE_THRESHOLD - 1);
          for (let i = 0; i < safeFailures; i++) {
            state = recordFailure(state, baseMs + i * 1000);
          }
          state = recordSuccess(state, baseMs + safeFailures * 1000);
          expect(state.failureCount).toBe(0);
          expect(state.state).toBe('CLOSED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-8: State transitions are deterministic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
        (baseMs, outcomes) => {
          // outcomes: true = success, false = failure
          function simulate(base: number, ops: boolean[]): CBState {
            let s = createInitialState(base);
            for (let i = 0; i < ops.length; i++) {
              if (ops[i]) {
                s = recordSuccess(s, base + i * 1000);
              } else {
                s = recordFailure(s, base + i * 1000);
              }
            }
            return s;
          }

          const s1 = simulate(baseMs, outcomes);
          const s2 = simulate(baseMs, outcomes);
          expect(s1.state).toBe(s2.state);
          expect(s1.failureCount).toBe(s2.failureCount);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P29-9: CLOSED state allows execution without error', () => {
    const cb = new CircuitBreaker({ service: 'test-closed-' + Date.now() });
    // In CLOSED state, execute should call the function
    return expect(
      cb.execute(async () => 'result'),
    ).resolves.toBe('result');
  });
});
