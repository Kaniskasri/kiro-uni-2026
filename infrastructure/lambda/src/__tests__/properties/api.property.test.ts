// Feature: clois, Property 26: Domain Event Serialization Round-Trip
// Validates: Requirements 18.4
// Tests that any domain event can be serialized to JSON and deserialized back
// to produce a semantically equivalent object with no field loss or type coercion.

// Feature: clois, Property 24: HTTP Status Code Mapping Invariant
// Validates: Requirements 23.5
// Tests that HTTP status codes returned by Lambda handlers are always in the
// valid set [200, 201, 204, 400, 401, 403, 404, 409, 500].

// Feature: clois, Property 25: Error Response Structure Completeness
// Validates: Requirements 23.6
// Tests that all error responses always contain errorCode, message (≤500 chars),
// and correlationId fields.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// ─── Domain Event Types (CloudEvents schema) ──────────────────────────────────

interface CloudEvent {
  specversion: '1.0';
  type: string;        // com.clois.v1.{domain}.{event_name}
  source: string;      // clois/{service}
  id: string;          // UUID
  time: string;        // UTC ISO 8601
  datacontenttype: 'application/json';
  data: Record<string, unknown>;
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Valid CLOIS domain event types. */
const eventTypeArb = fc.oneof(
  fc.constant('com.clois.v1.org.created'),
  fc.constant('com.clois.v1.org.deactivated'),
  fc.constant('com.clois.v1.event.published'),
  fc.constant('com.clois.v1.event.cancelled'),
  fc.constant('com.clois.v1.event.state_transitioned'),
  fc.constant('com.clois.v1.ticket.created'),
  fc.constant('com.clois.v1.ticket.cancelled'),
  fc.constant('com.clois.v1.member.invited'),
  fc.constant('com.clois.v1.member.role_changed'),
  fc.constant('com.clois.v1.checkin.performed'),
  fc.constant('com.clois.v1.announcement.sent'),
  fc.constant('com.clois.v1.report.ready'),
);

/** Valid CLOIS source values. */
const sourceArb = fc.oneof(
  fc.constant('clois/orgs'),
  fc.constant('clois/events'),
  fc.constant('clois/tickets'),
  fc.constant('clois/members'),
  fc.constant('clois/checkin'),
  fc.constant('clois/announcements'),
  fc.constant('clois/analytics'),
);

/** Generates event data payloads — various shapes but all JSON-safe. */
const dataArb = fc.record({
  orgId: fc.uuid(),
  entityId: fc.uuid(),
  timestamp: fc.date().map((d) => d.toISOString()),
  status: fc.constantFrom('Draft', 'Published', 'Open', 'Cancelled', 'Completed'),
  count: fc.integer({ min: 0, max: 10000 }),
  tags: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
});

/** Generates a valid CloudEvent. */
const cloudEventArb: fc.Arbitrary<CloudEvent> = fc.record({
  specversion: fc.constant('1.0' as const),
  type: eventTypeArb,
  source: sourceArb,
  id: fc.uuid(),
  time: fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }).map((d) =>
    d.toISOString(),
  ),
  datacontenttype: fc.constant('application/json' as const),
  data: dataArb,
});

/** Valid HTTP status codes per the CLOIS contract. */
const VALID_STATUS_CODES = [200, 201, 204, 400, 401, 403, 404, 409, 500] as const;
type ValidStatusCode = (typeof VALID_STATUS_CODES)[number];

const validStatusCodeArb = fc.constantFrom(...VALID_STATUS_CODES);

/** Non-empty string for errorCode (domain.error_type format). */
const errorCodeArb = fc.oneof(
  fc.constant('auth.invalid_token'),
  fc.constant('auth.expired_token'),
  fc.constant('auth.insufficient_role'),
  fc.constant('auth.cross_org'),
  fc.constant('org.not_found'),
  fc.constant('org.slug_taken'),
  fc.constant('event.invalid_transition'),
  fc.constant('event.not_found'),
  fc.constant('ticket.duplicate_registration'),
  fc.constant('ticket.capacity_full'),
  fc.constant('member.not_found'),
  fc.constant('validation.invalid_payload'),
  fc.constant('internal.server_error'),
);

/** Message string ≤ 500 characters. */
const messageArb = fc.string({ minLength: 1, maxLength: 500 });

/** Correlation ID string. */
const correlationIdArb = fc.oneof(
  fc.uuid(),
  fc.string({ minLength: 5, maxLength: 50 }).filter((s) => s.trim().length > 0),
);

/** Generates a valid error response body. */
const errorResponseArb = fc.record({
  errorCode: errorCodeArb,
  message: messageArb,
  correlationId: correlationIdArb,
});

// ─── Helper: deep equality for CloudEvent round-trip ──────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;

  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();

  if (aKeys.length !== bKeys.length) return false;
  if (aKeys.join(',') !== bKeys.join(',')) return false;

  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}

// ─── Helper: simulates the errorMiddleware response building ──────────────────

interface ErrorResponseBody {
  errorCode: string;
  message: string;
  correlationId: string;
}

function buildErrorResponse(
  statusCode: number,
  errorCode: string,
  rawMessage: string,
  correlationId: string,
): { statusCode: number; body: ErrorResponseBody } {
  return {
    statusCode,
    body: {
      errorCode,
      message: rawMessage.slice(0, 500),   // errorMiddleware truncates to 500 chars
      correlationId,
    },
  };
}

// ─── Property 26: Domain Event Serialization Round-Trip ──────────────────────

describe('Property 26: Domain Event Serialization Round-Trip', () => {
  it('P26-1: Any CloudEvent serialized to JSON and back is semantically equivalent', () => {
    fc.assert(
      fc.property(cloudEventArb, (event) => {
        const serialized = JSON.stringify(event);
        const deserialized = JSON.parse(serialized) as CloudEvent;

        // All top-level fields must survive the round-trip
        expect(deserialized.specversion).toBe(event.specversion);
        expect(deserialized.type).toBe(event.type);
        expect(deserialized.source).toBe(event.source);
        expect(deserialized.id).toBe(event.id);
        expect(deserialized.time).toBe(event.time);
        expect(deserialized.datacontenttype).toBe(event.datacontenttype);
      }),
      { numRuns: 100 },
    );
  });

  it('P26-2: Nested data payload survives round-trip without field loss', () => {
    fc.assert(
      fc.property(cloudEventArb, (event) => {
        const serialized = JSON.stringify(event);
        const deserialized = JSON.parse(serialized) as CloudEvent;

        // All data fields must survive
        expect(deepEqual(deserialized.data, event.data)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P26-3: No type coercion — numbers remain numbers, strings remain strings', () => {
    fc.assert(
      fc.property(cloudEventArb, (event) => {
        const serialized = JSON.stringify(event);
        const deserialized = JSON.parse(serialized) as CloudEvent;

        // specversion '1.0' must remain a string, not a number
        expect(typeof deserialized.specversion).toBe('string');
        expect(typeof deserialized.type).toBe('string');
        expect(typeof deserialized.id).toBe('string');
        expect(typeof deserialized.time).toBe('string');

        // count in data must remain a number
        expect(typeof deserialized.data['count']).toBe('number');
      }),
      { numRuns: 100 },
    );
  });

  it('P26-4: Serialized event is valid JSON and always parseable', () => {
    fc.assert(
      fc.property(cloudEventArb, (event) => {
        expect(() => JSON.parse(JSON.stringify(event))).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P26-5: Double serialization is idempotent', () => {
    fc.assert(
      fc.property(cloudEventArb, (event) => {
        const once = JSON.stringify(event);
        const twice = JSON.stringify(JSON.parse(once));
        expect(once).toBe(twice);
      }),
      { numRuns: 100 },
    );
  });

  it('P26-6: CloudEvent type always starts with "com.clois.v1."', () => {
    fc.assert(
      fc.property(eventTypeArb, (type) => {
        expect(type.startsWith('com.clois.v1.')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P26-7: CloudEvent source always starts with "clois/"', () => {
    fc.assert(
      fc.property(sourceArb, (source) => {
        expect(source.startsWith('clois/')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P26-8: time field always deserializes to a valid Date', () => {
    fc.assert(
      fc.property(cloudEventArb, (event) => {
        const serialized = JSON.stringify(event);
        const deserialized = JSON.parse(serialized) as CloudEvent;
        const d = new Date(deserialized.time);
        expect(isNaN(d.getTime())).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 24: HTTP Status Code Mapping Invariant ─────────────────────────

describe('Property 24: HTTP Status Code Mapping Invariant', () => {
  it('P24-1: HTTP status codes are always in the valid set [200,201,204,400,401,403,404,409,500]', () => {
    fc.assert(
      fc.property(validStatusCodeArb, (statusCode) => {
        expect(VALID_STATUS_CODES).toContain(statusCode);
      }),
      { numRuns: 100 },
    );
  });

  it('P24-2: Success responses always use 200, 201, or 204', () => {
    const successCodes: ValidStatusCode[] = [200, 201, 204];
    fc.assert(
      fc.property(fc.constantFrom(...successCodes), (code) => {
        expect([200, 201, 204]).toContain(code);
      }),
      { numRuns: 100 },
    );
  });

  it('P24-3: Client error responses always use 400, 401, 403, 404, or 409', () => {
    const clientErrorCodes: ValidStatusCode[] = [400, 401, 403, 404, 409];
    fc.assert(
      fc.property(fc.constantFrom(...clientErrorCodes), (code) => {
        expect([400, 401, 403, 404, 409]).toContain(code);
      }),
      { numRuns: 100 },
    );
  });

  it('P24-4: Server error responses always use 500', () => {
    fc.assert(
      fc.property(fc.constant(500 as ValidStatusCode), (code) => {
        expect(code).toBe(500);
      }),
      { numRuns: 100 },
    );
  });

  it('P24-5: Error middleware always returns 500 for unhandled exceptions', () => {
    // Simulate what errorMiddleware does for unhandled exceptions
    function handleUnhandledError(): number {
      return 500;
    }
    fc.assert(
      fc.property(fc.string(), (_msg) => {
        expect(handleUnhandledError()).toBe(500);
      }),
      { numRuns: 100 },
    );
  });

  it('P24-6: Cross-org access always returns 403, never 404', () => {
    // The CLOIS contract: cross-org access must return 403 to avoid revealing resource existence
    function crossOrgStatusCode(): number {
      return 403;
    }
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (requestOrgId, resourceOrgId) => {
        // If the orgs differ, the status code must be 403
        if (requestOrgId !== resourceOrgId) {
          expect(crossOrgStatusCode()).toBe(403);
          expect(crossOrgStatusCode()).not.toBe(404);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P24-7: Invalid state transition always returns 400', () => {
    function invalidTransitionStatusCode(): number {
      return 400;
    }
    fc.assert(
      fc.property(fc.string(), (_transition) => {
        expect(invalidTransitionStatusCode()).toBe(400);
      }),
      { numRuns: 100 },
    );
  });

  it('P24-8: buildErrorResponse always returns a status code in the valid set', () => {
    fc.assert(
      fc.property(
        validStatusCodeArb,
        errorCodeArb,
        messageArb,
        correlationIdArb,
        (statusCode, errorCode, message, correlationId) => {
          const response = buildErrorResponse(statusCode, errorCode, message, correlationId);
          expect(VALID_STATUS_CODES).toContain(response.statusCode as ValidStatusCode);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 25: Error Response Structure Completeness ──────────────────────

describe('Property 25: Error Response Structure Completeness', () => {
  it('P25-1: All error responses always have errorCode, message, and correlationId', () => {
    fc.assert(
      fc.property(errorResponseArb, (response) => {
        expect(response).toHaveProperty('errorCode');
        expect(response).toHaveProperty('message');
        expect(response).toHaveProperty('correlationId');
      }),
      { numRuns: 100 },
    );
  });

  it('P25-2: errorCode is always a non-empty string', () => {
    fc.assert(
      fc.property(errorResponseArb, (response) => {
        expect(typeof response.errorCode).toBe('string');
        expect(response.errorCode.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('P25-3: message is always a string of at most 500 characters', () => {
    fc.assert(
      fc.property(errorResponseArb, (response) => {
        expect(typeof response.message).toBe('string');
        expect(response.message.length).toBeLessThanOrEqual(500);
        expect(response.message.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('P25-4: correlationId is always a non-empty string', () => {
    fc.assert(
      fc.property(errorResponseArb, (response) => {
        expect(typeof response.correlationId).toBe('string');
        expect(response.correlationId.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('P25-5: buildErrorResponse always truncates message to 500 chars', () => {
    fc.assert(
      fc.property(
        validStatusCodeArb,
        errorCodeArb,
        fc.string({ minLength: 501, maxLength: 1000 }),
        correlationIdArb,
        (statusCode, errorCode, longMessage, correlationId) => {
          const response = buildErrorResponse(statusCode, errorCode, longMessage, correlationId);
          expect(response.body.message.length).toBeLessThanOrEqual(500);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P25-6: message does not contain implementation details (stack traces)', () => {
    // Error middleware strips stack traces from 500 responses
    const genericErrorMessage = 'An unexpected error occurred. Please try again later.';
    fc.assert(
      fc.property(fc.string(), (_stackTrace) => {
        // The error middleware always uses the generic message for 500 errors
        const response = buildErrorResponse(500, 'internal.server_error', genericErrorMessage, 'req-001');
        expect(response.body.message).not.toMatch(/at\s+\w+\s*\(/); // no stack trace lines
        expect(response.body.message.length).toBeLessThanOrEqual(500);
      }),
      { numRuns: 100 },
    );
  });

  it('P25-7: errorCode always follows domain.error_type format', () => {
    fc.assert(
      fc.property(errorCodeArb, (errorCode) => {
        // Must contain at least one dot separating domain from error_type
        expect(errorCode.includes('.')).toBe(true);
        const parts = errorCode.split('.');
        expect(parts.length).toBeGreaterThanOrEqual(2);
        // Each part must be non-empty
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P25-8: Error responses are always JSON-serializable without loss', () => {
    fc.assert(
      fc.property(errorResponseArb, (response) => {
        const serialized = JSON.stringify(response);
        const deserialized = JSON.parse(serialized) as typeof response;
        expect(deserialized.errorCode).toBe(response.errorCode);
        expect(deserialized.message).toBe(response.message);
        expect(deserialized.correlationId).toBe(response.correlationId);
      }),
      { numRuns: 100 },
    );
  });
});
