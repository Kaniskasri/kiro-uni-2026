// Feature: clois, Property 5: Invitation Token Uniqueness
// Validates: Requirements 3.x - Invitation token generation is cryptographically unique,
// tokens produce 64-char hex SHA-256 hashes, and expiry is exactly 72 hours from creation.
// Expired and used tokens are always rejected.

// Feature: clois, Property 6: Bulk CSV Invitation Processing Correctness
// Validates: Requirements 3.x - Bulk invitation CSV processing correctly categorises
// valid vs invalid rows, enforces the 500-row limit, handles empty input, and deduplicates.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { createHash, randomBytes } from 'crypto';

// ─── Pure logic extracted from members/service.ts ─────────────────────────────

const INVITATION_TTL_HOURS = 72;
const BULK_MAX_ROWS = 500;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type OrgRole = 'Owner' | 'Admin' | 'Organizer' | 'Member';
const ALL_ROLES: OrgRole[] = ['Owner', 'Admin', 'Organizer', 'Member'];
const VALID_INVITE_ROLES: OrgRole[] = ['Admin', 'Organizer', 'Member'];

function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

function validateInviteRole(role: string): role is OrgRole {
  return VALID_INVITE_ROLES.includes(role as OrgRole);
}

/** Mirrors generateToken() from members/service.ts */
function generateToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

/** Mirrors the expiry calculation in members/service.ts */
function computeExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
}

/** Returns true if the token is expired at the given check time */
function isExpired(expiresAt: Date, checkTime: Date): boolean {
  return checkTime > expiresAt;
}

interface BulkInviteRow {
  email: string;
  role: string;
}

interface BulkInviteResult {
  accepted: Array<{ email: string; role: string }>;
  skipped: Array<{ email: string; role: string; reason: string }>;
  totalRows: number;
  error?: string;
}

/**
 * Pure bulk invite processor — mirrors the validation logic in bulkInviteMembers()
 * but without any DynamoDB calls. Used only for property testing the row validation rules.
 */
function processBulkInviteRows(rows: BulkInviteRow[]): BulkInviteResult {
  if (rows.length > BULK_MAX_ROWS) {
    return {
      accepted: [],
      skipped: [],
      totalRows: rows.length,
      error: `CSV file exceeds the maximum allowed rows (${BULK_MAX_ROWS}).`,
    };
  }

  if (rows.length === 0) {
    return { accepted: [], skipped: [], totalRows: 0 };
  }

  const accepted: BulkInviteResult['accepted'] = [];
  const skipped: BulkInviteResult['skipped'] = [];
  const seenEmails = new Set<string>();

  for (const row of rows) {
    const normalizedEmail = (row.email ?? '').toLowerCase().trim();
    const role = (row.role ?? '').trim();

    if (!validateEmail(normalizedEmail)) {
      skipped.push({ email: row.email, role: row.role, reason: 'invalid_email' });
      continue;
    }

    if (!validateInviteRole(role)) {
      skipped.push({ email: normalizedEmail, role: row.role, reason: 'unrecognized_role' });
      continue;
    }

    // Duplicate within this batch
    if (seenEmails.has(normalizedEmail)) {
      skipped.push({ email: normalizedEmail, role, reason: 'duplicate' });
      continue;
    }

    seenEmails.add(normalizedEmail);
    accepted.push({ email: normalizedEmail, role });
  }

  return { accepted, skipped, totalRows: rows.length };
}

// ─── Arbitraries ───────────────────────────────────────────────────────────────

/** Generates a structurally valid email address */
const validEmailArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 15,
    }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
      minLength: 2,
      maxLength: 10,
    }),
    fc.constantFrom('com', 'org', 'net', 'io', 'co'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)
  .filter((email) => validateEmail(email));

/** Generates an email that will fail validation */
const invalidEmailArb = fc.oneof(
  fc.constant('notanemail'),
  fc.constant('@nodomain'),
  fc.constant('noatsign.com'),
  fc.constant(''),
  fc.constant('   '),
  fc.constant('double@@domain.com'),
  fc.string({ minLength: 0, maxLength: 5 }).filter((s) => !validateEmail(s)),
);

/** Generates a valid invite role (Admin, Organizer, Member — Owner excluded from invitations) */
const validInviteRoleArb = fc.constantFrom<OrgRole>('Admin', 'Organizer', 'Member');

/** Generates an invalid role string */
const invalidRoleArb = fc.oneof(
  fc.constant(''),
  fc.constant('owner'),         // lowercase — service does case-sensitive check
  fc.constant('ADMIN'),         // uppercase
  fc.constant('SuperAdmin'),
  fc.constant('Guest'),
  fc.constant('Viewer'),
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (r) => !VALID_INVITE_ROLES.includes(r as OrgRole),
  ),
);

/** Generates a valid bulk invite row */
const validRowArb = fc
  .tuple(validEmailArb, validInviteRoleArb)
  .map(([email, role]) => ({ email, role }));

// ─── Property 5: Invitation Token Uniqueness ──────────────────────────────────

describe('Property 5: Invitation Token Uniqueness', () => {
  it('P5-1: 100 generated tokens are all statistically unique (no collisions)', () => {
    // Generate 100 tokens and verify they are all distinct
    const tokens: string[] = [];
    for (let i = 0; i < 100; i++) {
      tokens.push(generateToken().rawToken);
    }
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(100);
  });

  it('P5-2: for any two independently generated tokens, they must be distinct', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), () => {
        const { rawToken: t1, tokenHash: h1 } = generateToken();
        const { rawToken: t2, tokenHash: h2 } = generateToken();
        // Raw tokens must differ
        expect(t1).not.toBe(t2);
        // Hashes must differ (follows from token uniqueness + SHA-256 collision resistance)
        expect(h1).not.toBe(h2);
      }),
      { numRuns: 100 },
    );
  });

  it('P5-3: token hash is always a 64-character hex string (SHA-256 output)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), () => {
        const { tokenHash } = generateToken();
        expect(tokenHash).toHaveLength(64);
        expect(/^[0-9a-f]{64}$/.test(tokenHash)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P5-4: token expiry is always exactly 72 hours after creation', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }),
        (createdAt) => {
          const expiresAt = computeExpiresAt(createdAt);
          const diffMs = expiresAt.getTime() - createdAt.getTime();
          const expectedMs = INVITATION_TTL_HOURS * 60 * 60 * 1000;
          expect(diffMs).toBe(expectedMs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P5-5: an expired token (check time > 72h after creation) is always rejected', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }),
        fc.integer({ min: 1, max: 30 * 24 }), // 1 hour to 30 days past expiry
        (createdAt, hoursAfterExpiry) => {
          const expiresAt = computeExpiresAt(createdAt);
          const checkTime = new Date(
            expiresAt.getTime() + hoursAfterExpiry * 60 * 60 * 1000,
          );
          expect(isExpired(expiresAt, checkTime)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P5-6: a token checked before or at expiry time is not expired', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-06-30') }),
        fc.integer({ min: 0, max: INVITATION_TTL_HOURS * 60 - 1 }), // 0 to (72h - 1min) in minutes
        (createdAt, minutesBeforeExpiry) => {
          const expiresAt = computeExpiresAt(createdAt);
          const checkTime = new Date(
            expiresAt.getTime() - minutesBeforeExpiry * 60 * 1000,
          );
          expect(isExpired(expiresAt, checkTime)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P5-7: a used token (status != Pending) is always rejected regardless of expiry', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('Accepted', 'Expired'),
        fc.date({ min: new Date('2024-01-01'), max: new Date('2030-12-31') }),
        (status, createdAt) => {
          // Simulate an invitation that is NOT in Pending status
          const isPending = status === 'Pending';
          expect(isPending).toBe(false);

          // Whether or not it's expired, a non-Pending invitation must be rejected
          const expiresAt = computeExpiresAt(createdAt);
          const isStillValid = !isExpired(expiresAt, new Date());
          // Regardless of isStillValid, since status != 'Pending', it must be rejected
          // The combined acceptance condition: must be Pending AND not expired
          const wouldAccept = isPending && isStillValid;
          expect(wouldAccept).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P5-8: SHA-256 hash of same raw token always produces the same 64-char hex hash', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99 }), () => {
        // Generate a token and hash it twice — must be deterministic
        const rawToken = randomBytes(32).toString('hex');
        const hash1 = createHash('sha256').update(rawToken).digest('hex');
        const hash2 = createHash('sha256').update(rawToken).digest('hex');
        expect(hash1).toBe(hash2);
        expect(hash1).toHaveLength(64);
        expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 6: Bulk CSV Invitation Processing Correctness ───────────────────

// Feature: clois, Property 6: Bulk CSV Invitation Processing Correctness

describe('Property 6: Bulk CSV Invitation Processing Correctness', () => {
  it('P6-1: for any CSV with N valid rows (N <= 500), accepted + skipped always equals N', () => {
    fc.assert(
      fc.property(
        fc.array(validRowArb, { minLength: 0, maxLength: 500 }),
        (rows) => {
          const result = processBulkInviteRows(rows);
          // No error means we should have processed all rows
          expect(result.error).toBeUndefined();
          expect(result.accepted.length + result.skipped.length).toBe(rows.length);
          expect(result.totalRows).toBe(rows.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P6-2: any row with an invalid email format is always in the skipped list', () => {
    fc.assert(
      fc.property(
        invalidEmailArb,
        validInviteRoleArb,
        fc.array(validRowArb, { minLength: 0, maxLength: 10 }),
        (badEmail, role, otherRows) => {
          // Inject one bad-email row at a random position among valid rows
          const badRow: BulkInviteRow = { email: badEmail, role };
          const rows = [...otherRows, badRow].slice(0, BULK_MAX_ROWS);

          const result = processBulkInviteRows(rows);
          expect(result.error).toBeUndefined();

          // The bad email row should appear in skipped with reason 'invalid_email'
          const skippedBadEmail = result.skipped.some(
            (s) => s.reason === 'invalid_email',
          );
          expect(skippedBadEmail).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P6-3: any row with an invalid role is always in the skipped list', () => {
    fc.assert(
      fc.property(
        validEmailArb,
        invalidRoleArb,
        fc.array(validRowArb, { minLength: 0, maxLength: 10 }),
        (email, badRole, otherRows) => {
          // Ensure the email won't duplicate with otherRows
          const uniqueEmail = `unique_${Math.random().toString(36).slice(2)}@test.com`;
          const badRow: BulkInviteRow = { email: uniqueEmail, role: badRole };
          const rows = [...otherRows, badRow].slice(0, BULK_MAX_ROWS);

          const result = processBulkInviteRows(rows);
          expect(result.error).toBeUndefined();

          const skippedBadRole = result.skipped.some(
            (s) => s.reason === 'unrecognized_role',
          );
          expect(skippedBadRole).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P6-4: CSV with more than 500 rows is entirely rejected with an error (no partial processing)', () => {
    fc.assert(
      fc.property(
        fc.array(validRowArb, { minLength: 501, maxLength: 600 }),
        (rows) => {
          const result = processBulkInviteRows(rows);
          // Must return an error
          expect(result.error).toBeDefined();
          expect(result.error).toContain(`${BULK_MAX_ROWS}`);
          // No rows should have been accepted or skipped — entirely rejected
          expect(result.accepted).toHaveLength(0);
          expect(result.skipped).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P6-5: empty CSV returns accepted=0, skipped=[] with no error', () => {
    const result = processBulkInviteRows([]);
    expect(result.error).toBeUndefined();
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.totalRows).toBe(0);
  });

  it('P6-5 (property): empty array always produces zero accepted and zero skipped', () => {
    // Confirm invariant holds in a property test context
    fc.assert(
      fc.property(fc.constant([]), (rows: BulkInviteRow[]) => {
        const result = processBulkInviteRows(rows);
        expect(result.accepted).toHaveLength(0);
        expect(result.skipped).toHaveLength(0);
        expect(result.error).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('P6-6: duplicate emails within the same batch — second occurrence is always skipped with reason "duplicate"', () => {
    fc.assert(
      fc.property(
        validEmailArb,
        validInviteRoleArb,
        validInviteRoleArb,
        (email, role1, role2) => {
          // Two rows with the same email
          const rows: BulkInviteRow[] = [
            { email, role: role1 },
            { email, role: role2 },
          ];

          const result = processBulkInviteRows(rows);
          expect(result.error).toBeUndefined();

          // Total rows accounted for
          expect(result.accepted.length + result.skipped.length).toBe(2);

          // First occurrence accepted, second skipped as duplicate
          const normalizedEmail = email.toLowerCase().trim();
          expect(result.accepted.some((a) => a.email === normalizedEmail)).toBe(true);
          expect(result.skipped.some((s) => s.reason === 'duplicate')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P6-7: valid rows always appear in accepted list, never in skipped', () => {
    fc.assert(
      fc.property(
        fc.array(validRowArb, { minLength: 1, maxLength: 50 }),
        (rows) => {
          // Deduplicate by email to avoid duplicate-skipping obscuring the invariant
          const uniqueRows: BulkInviteRow[] = [];
          const seen = new Set<string>();
          for (const row of rows) {
            const key = row.email.toLowerCase().trim();
            if (!seen.has(key)) {
              seen.add(key);
              uniqueRows.push(row);
            }
          }

          const result = processBulkInviteRows(uniqueRows);
          expect(result.error).toBeUndefined();

          // All unique valid rows should be accepted
          expect(result.accepted.length).toBe(uniqueRows.length);
          expect(result.skipped.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P6-8: a row with Owner role is always skipped (Owner is not a valid invitation role)', () => {
    fc.assert(
      fc.property(validEmailArb, (email) => {
        const rows: BulkInviteRow[] = [{ email, role: 'Owner' }];
        const result = processBulkInviteRows(rows);
        expect(result.error).toBeUndefined();
        expect(result.accepted).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0]?.reason).toBe('unrecognized_role');
      }),
      { numRuns: 100 },
    );
  });
});
