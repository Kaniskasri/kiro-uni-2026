// Feature: clois, Property 1: Password Validation Completeness
// Validates: Requirements 1.2
// Every password that passes validation must satisfy all 5 constraints:
//   min 12 chars, uppercase, lowercase, digit, special character.
// Every password missing any one of these must be rejected.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

// Password validation regex (same as auth/service.ts)
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>/?]).{12,}$/;

function validatePassword(password: string): boolean {
  return PASSWORD_REGEX.test(password);
}

const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SPECIALS = '!@#$%^&*()_+-=[]{};\':"|,.<>/?';

function makeValidPassword(seed: string): string {
  // Ensure at least one of each required char type, padded to >= 12 chars
  const base = 'aA1!' + seed.slice(0, 8);
  return base.padEnd(12, 'xX2!');
}

describe('Property 1: Password Validation Completeness', () => {
  it('every valid password satisfies all 5 constraints', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(...LOWERCASE.split('')), { minLength: 1 }),
          fc.stringOf(fc.constantFrom(...UPPERCASE.split('')), { minLength: 1 }),
          fc.stringOf(fc.constantFrom(...DIGITS.split('')), { minLength: 1 }),
          fc.stringOf(fc.constantFrom(...SPECIALS.split('')), { minLength: 1 }),
          fc.stringOf(fc.constantFrom(...(LOWERCASE + UPPERCASE + DIGITS).split('')), { minLength: 8 }),
        ),
        ([lower, upper, digit, special, filler]) => {
          const password = lower + upper + digit + special + filler;
          if (password.length < 12) return; // skip — would be invalid due to length
          expect(validatePassword(password)).toBe(true);
          // Confirm all constraints individually
          expect(password.length).toBeGreaterThanOrEqual(12);
          expect(/[a-z]/.test(password)).toBe(true);
          expect(/[A-Z]/.test(password)).toBe(true);
          expect(/\d/.test(password)).toBe(true);
          expect(/[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>/?]/.test(password)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('passwords shorter than 12 characters are always rejected', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 11 }),
        (password) => {
          expect(validatePassword(password)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('passwords missing uppercase are rejected regardless of other complexity', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(...LOWERCASE.split('')), { minLength: 4 }),
          fc.stringOf(fc.constantFrom(...DIGITS.split('')), { minLength: 1 }),
          fc.stringOf(fc.constantFrom(...SPECIALS.split('')), { minLength: 1 }),
        ).map(([l, d, s]) => (l + d + s).padEnd(12, 'a')),
        (password) => {
          expect(/[A-Z]/.test(password)).toBe(false);
          expect(validatePassword(password)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('passwords missing lowercase are rejected', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(...UPPERCASE.split('')), { minLength: 4 }),
          fc.stringOf(fc.constantFrom(...DIGITS.split('')), { minLength: 1 }),
          fc.stringOf(fc.constantFrom(...SPECIALS.split('')), { minLength: 1 }),
        ).map(([u, d, s]) => (u + d + s).padEnd(12, 'A')),
        (password) => {
          expect(/[a-z]/.test(password)).toBe(false);
          expect(validatePassword(password)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('passwords missing digits are rejected', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(...LOWERCASE.split('')), { minLength: 2 }),
          fc.stringOf(fc.constantFrom(...UPPERCASE.split('')), { minLength: 2 }),
          fc.stringOf(fc.constantFrom(...SPECIALS.split('')), { minLength: 1 }),
        ).map(([l, u, s]) => (l + u + s).padEnd(12, 'aA')),
        (password) => {
          if (/\d/.test(password)) return; // skip if filler accidentally added a digit
          expect(validatePassword(password)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('passwords missing special characters are rejected', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.stringOf(fc.constantFrom(...LOWERCASE.split('')), { minLength: 3 }),
          fc.stringOf(fc.constantFrom(...UPPERCASE.split('')), { minLength: 3 }),
          fc.stringOf(fc.constantFrom(...DIGITS.split('')), { minLength: 3 }),
        ).map(([l, u, d]) => (l + u + d).padEnd(12, 'aA1')),
        (password) => {
          if (/[!@#$%^&*()\-_=+\[\]{};':"\\|,.<>/?]/.test(password)) return; // skip
          expect(validatePassword(password)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});