// Feature: clois, Property 9: Venue Capacity Override Enforcement
// Validates: Requirements for Venue management (Task 6.1)
// Tests that venue capacity and validation constraints are always enforced.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  validateVenueName,
  validateVenueCapacity,
  validateAmenities,
  validateVenueAddress,
} from '../../venues/service';

// ─── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Simulates the capacity override check:
 * If a venue is assigned, event capacity must not exceed venue capacity.
 * Returns HTTP 400 if the override is attempted.
 */
function checkCapacityOverride(
  eventCapacity: number,
  venueCapacity: number,
  hasVenue: boolean,
): { statusCode: number } {
  if (!hasVenue) {
    // Virtual events with no venue have no capacity constraint from venue
    return { statusCode: 200 };
  }
  if (eventCapacity > venueCapacity) {
    return { statusCode: 400 };
  }
  return { statusCode: 200 };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Generates valid venue capacities within [1, 999999]. */
const validCapacityArb = fc.integer({ min: 1, max: 999_999 });

/** Generates invalid capacity values (0, negative, or > 999999). */
const invalidCapacityArb = fc.oneof(
  fc.integer({ min: -100_000, max: 0 }),
  fc.integer({ min: 1_000_000, max: 10_000_000 }),
);

/** Generates valid venue names within [1, 200] chars. */
const validNameArb = fc.string({ minLength: 1, maxLength: 200 });

/** Generates invalid venue names (empty or > 200 chars). */
const invalidNameArb = fc.oneof(
  fc.constant(''),
  fc.string({ minLength: 201, maxLength: 400 }),
);

/** Generates a valid amenities array (count <= 50, each item <= 100 chars). */
const validAmenitiesArb = fc.array(
  fc.string({ minLength: 1, maxLength: 100 }),
  { minLength: 0, maxLength: 50 },
);

/** Generates a valid venue address [1, 500 chars]. */
const validAddressArb = fc.string({ minLength: 1, maxLength: 500 });

// ─── Property 9-1: Event capacity never exceeds venue capacity when assigned ──

describe('Property 9: Venue Capacity Override Enforcement', () => {
  it('P9-1: Event capacity never exceeds venue capacity when a venue is assigned', () => {
    fc.assert(
      fc.property(
        validCapacityArb,
        validCapacityArb,
        (venueCapacity, eventCapacity) => {
          const result = checkCapacityOverride(eventCapacity, venueCapacity, true);
          if (eventCapacity > venueCapacity) {
            expect(result.statusCode).toBe(400);
          } else {
            expect(result.statusCode).toBe(200);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P9-2: Capacity override attempt always rejected with 400 when venue is assigned', () => {
    fc.assert(
      fc.property(
        validCapacityArb,
        (venueCapacity) => {
          // Generate event capacity that is strictly greater than venue capacity
          const eventCapacity = venueCapacity + 1;
          const result = checkCapacityOverride(eventCapacity, venueCapacity, true);
          expect(result.statusCode).toBe(400);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P9-3: Virtual events with no venue assigned have no capacity constraint from venue', () => {
    fc.assert(
      fc.property(
        validCapacityArb,
        validCapacityArb,
        (venueCapacity, eventCapacity) => {
          // No venue assigned — any event capacity is allowed regardless of venue capacity
          const result = checkCapacityOverride(eventCapacity, venueCapacity, false);
          expect(result.statusCode).toBe(200);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P9-4: Venue capacity must be within [1, 999999] range — valid values always accepted', () => {
    fc.assert(
      fc.property(validCapacityArb, (capacity) => {
        expect(() => validateVenueCapacity(capacity)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P9-4b: Venue capacity outside [1, 999999] is always rejected', () => {
    fc.assert(
      fc.property(invalidCapacityArb, (capacity) => {
        expect(() => validateVenueCapacity(capacity)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P9-5: Venue name within [1, 200] chars is always accepted', () => {
    fc.assert(
      fc.property(validNameArb, (name) => {
        expect(() => validateVenueName(name)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P9-5b: Venue name outside [1, 200] chars is always rejected', () => {
    fc.assert(
      fc.property(invalidNameArb, (name) => {
        expect(() => validateVenueName(name)).toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P9-6: Amenities count <= 50 is always accepted', () => {
    fc.assert(
      fc.property(validAmenitiesArb, (amenities) => {
        expect(() => validateAmenities(amenities)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P9-6b: Amenities count > 50 is always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 100 }),
          { minLength: 51, maxLength: 80 },
        ),
        (amenities) => {
          expect(() => validateAmenities(amenities)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P9-6c: Amenity item exceeding 100 chars is always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 101, maxLength: 200 }),
          { minLength: 1, maxLength: 5 },
        ),
        (amenities) => {
          expect(() => validateAmenities(amenities)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P9-7: Valid venue address [1, 500] chars is always accepted', () => {
    fc.assert(
      fc.property(validAddressArb, (address) => {
        expect(() => validateVenueAddress(address)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P9-7b: Venue address outside [1, 500] chars is always rejected', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(''),
          fc.string({ minLength: 501, maxLength: 700 }),
        ),
        (address) => {
          expect(() => validateVenueAddress(address)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});
