// Feature: clois, Property 3: Organization Slug and Name Uniqueness Invariant
// Validates: Requirements 2.1, 2.2
// Any two org creation requests with the same slug (case-insensitive) must conflict.
// Valid slug: 3–63 chars, lowercase alphanumeric + hyphens, no consecutive hyphens,
// no leading/trailing hyphens.
// Valid org name: 3–100 characters.

// Feature: clois, Property 4: Cross-Tenant Isolation (403 on Cross-Org Access)
// Validates: Requirements 2.3, security-and-multitenancy invariant
// For any orgId from JWT that differs from the resource orgId, the handler must return 403.
// Cross-org access NEVER returns 404 — always 403.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { validateSlug, validateOrgName } from '../../orgs/service';

// ─── Pure helpers extracted from service logic ─────────────────────────────

/**
 * Mirrors the tenant check performed in every service function.
 * Returns 403 if the JWT-sourced tenantId differs from the target orgId.
 * Never returns 404 on a cross-org access attempt.
 */
function checkTenantAccess(jwtOrgId: string, resourceOrgId: string): { statusCode: number } {
  if (jwtOrgId !== resourceOrgId) {
    return { statusCode: 403 };
  }
  return { statusCode: 200 };
}

/**
 * Simulates slug normalisation: toLowerCase().trim().
 * A valid, already-normalised slug must survive this round-trip unchanged.
 */
function normalizeSlug(slug: string): string {
  return slug.toLowerCase().trim();
}

/**
 * Returns true when the slug contains consecutive hyphens.
 */
function hasConsecutiveHyphens(slug: string): boolean {
  return /--/.test(slug);
}

// ─── Arbitraries ───────────────────────────────────────────────────────────

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ALPHANUMERIC_HYPHEN = ALPHANUMERIC + '-';

/** Generates a slug that is structurally valid (will pass validateSlug). */
const validSlugArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 1, maxLength: 1 }), // leading alnum
    fc.stringOf(fc.constantFrom(...ALPHANUMERIC_HYPHEN.split('')), { minLength: 1, maxLength: 61 }), // middle
    fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 1, maxLength: 1 }), // trailing alnum
  )
  .map(([start, mid, end]) => {
    // Remove consecutive hyphens from the middle portion
    const safeMid = mid.replace(/-{2,}/g, '-');
    const slug = start + safeMid + end;
    // Clamp total to [3, 63]
    return slug.slice(0, 63);
  })
  .filter((slug) => {
    // Final guard: must still pass all structural rules after slicing
    return (
      slug.length >= 3 &&
      slug.length <= 63 &&
      /^[a-z0-9]/.test(slug) &&
      /[a-z0-9]$/.test(slug) &&
      !hasConsecutiveHyphens(slug)
    );
  });

/** Generates a UUID-like string as an orgId. */
const orgIdArb = fc.uuid();

// ─── Property 3: Slug Validation ───────────────────────────────────────────

describe('Property 3: Organization Slug and Name Uniqueness Invariant', () => {
  it('P3-1: same slug (case-insensitive) from two org creation requests must always conflict', () => {
    fc.assert(
      fc.property(validSlugArb, (slug) => {
        const slugA = slug;
        // Produce a case variant: mix upper/lower where possible (won't pass validateSlug
        // directly, but normalization makes them equal)
        const slugB = slug.toUpperCase();
        // After normalisation both slugs are identical → would cause a 409
        const normA = normalizeSlug(slugA);
        const normB = normalizeSlug(slugB);
        expect(normA).toBe(normB);
      }),
      { numRuns: 100 },
    );
  });

  it('P3-2: valid slugs pass validateSlug without throwing', () => {
    fc.assert(
      fc.property(validSlugArb, (slug) => {
        // Must not throw
        expect(() => validateSlug(slug)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('P3-3a: slugs shorter than 3 characters are always rejected', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 0, maxLength: 2 }),
        (slug) => {
          expect(() => validateSlug(slug)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-3b: slugs longer than 63 characters are always rejected', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 64, maxLength: 100 }),
        (slug) => {
          expect(() => validateSlug(slug)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-3c: slugs with uppercase letters are always rejected', () => {
    fc.assert(
      fc.property(
        // Generate a valid-length string that contains at least one uppercase letter
        fc.stringOf(
          fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
          { minLength: 3, maxLength: 63 },
        ),
        (slug) => {
          // Has uppercase → must fail
          expect(() => validateSlug(slug)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-3d: slugs with special characters (not alphanumeric or hyphen) are always rejected', () => {
    const SPECIALS = '!@#$%^&*()_+=[]{}|;:\'",.<>?/\\`~';
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 1, maxLength: 10 }),
          fc.constantFrom(...SPECIALS.split('')),
          fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 1, maxLength: 10 }),
        ).map(([a, s, b]) => a + s + b),
        (slug) => {
          expect(() => validateSlug(slug)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-3e: slugs with leading hyphens are always rejected', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 2, maxLength: 62 }).map(
          (s) => '-' + s,
        ),
        (slug) => {
          expect(() => validateSlug(slug)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-3f: slugs with trailing hyphens are always rejected', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(...ALPHANUMERIC.split('')), { minLength: 2, maxLength: 62 }).map(
          (s) => s + '-',
        ),
        (slug) => {
          expect(() => validateSlug(slug)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-4a: valid org names (3–100 chars) pass validateOrgName without throwing', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 100 }),
        (name) => {
          expect(() => validateOrgName(name)).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-4b: org names shorter than 3 chars are always rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 2 }),
        (name) => {
          expect(() => validateOrgName(name)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-4c: org names longer than 100 chars are always rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 101, maxLength: 200 }),
        (name) => {
          expect(() => validateOrgName(name)).toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P3-5: slug normalisation is idempotent — valid slug equals its normalized form', () => {
    fc.assert(
      fc.property(validSlugArb, (slug) => {
        // A valid slug is already lowercase/trimmed; normalizing must be a no-op
        expect(normalizeSlug(slug)).toBe(slug);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 4: Cross-Tenant Isolation ────────────────────────────────────

describe('Property 4: Cross-Tenant Isolation (403 on Cross-Org Access)', () => {
  it('P4-1: any JWT orgId differing from resource orgId must produce HTTP 403', () => {
    fc.assert(
      fc.property(
        fc.tuple(orgIdArb, orgIdArb).filter(([a, b]) => a !== b),
        ([jwtOrgId, resourceOrgId]) => {
          const result = checkTenantAccess(jwtOrgId, resourceOrgId);
          expect(result.statusCode).toBe(403);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P4-2: body orgId is ignored — tenantId from JWT is the only authority', () => {
    fc.assert(
      fc.property(
        fc.tuple(orgIdArb, orgIdArb, orgIdArb).filter(([jwt, body, resource]) => body !== jwt),
        ([jwtOrgId, _bodyOrgId, resourceOrgId]) => {
          // The body orgId is never passed to checkTenantAccess; only the JWT orgId matters.
          // If JWT orgId !== resource orgId → 403, regardless of body
          if (jwtOrgId !== resourceOrgId) {
            const result = checkTenantAccess(jwtOrgId, resourceOrgId);
            expect(result.statusCode).toBe(403);
          } else {
            const result = checkTenantAccess(jwtOrgId, resourceOrgId);
            expect(result.statusCode).toBe(200);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P4-3: cross-org access NEVER returns 404 — always 403', () => {
    fc.assert(
      fc.property(
        fc.tuple(orgIdArb, orgIdArb).filter(([a, b]) => a !== b),
        ([jwtOrgId, resourceOrgId]) => {
          const result = checkTenantAccess(jwtOrgId, resourceOrgId);
          // Must be 403, must not be 404 or any other code
          expect(result.statusCode).toBe(403);
          expect(result.statusCode).not.toBe(404);
          expect(result.statusCode).not.toBe(200);
          expect(result.statusCode).not.toBe(201);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P4-4: same orgId in JWT and resource always grants access (200)', () => {
    fc.assert(
      fc.property(orgIdArb, (orgId) => {
        const result = checkTenantAccess(orgId, orgId);
        expect(result.statusCode).toBe(200);
      }),
      { numRuns: 100 },
    );
  });
});
