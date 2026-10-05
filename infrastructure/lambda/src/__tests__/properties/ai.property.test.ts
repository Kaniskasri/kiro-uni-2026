// Feature: clois, Property 20: No PII in Bedrock Prompts
// Feature: clois, Property 21: AI Response Validation Rejection
// Feature: clois, Property 22: Scheduling Suggestion Range and Ordering
// Feature: clois, Property 23: Sentiment Score Range Enforcement

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  containsPII,
  validateDescriptionResponse,
  validateSchedulingSuggestions,
  clampSentimentScore,
  stripPII,
} from '../../ai/service';
import { ScheduleSuggestion } from '../../ai/types';

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Valid event title (no PII) */
const cleanTitleArb = fc.string({ minLength: 1, maxLength: 100 }).filter(
  (s) => !containsPII(s) && s.trim().length > 0,
);

/** Valid keyword array (no PII) */
const cleanKeywordsArb = fc.array(
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !containsPII(s)),
  { minLength: 0, maxLength: 10 },
);

/** Email address strings */
const emailArb = fc.emailAddress();

/** UUID member ID strings */
const uuidArb = fc.uuid();

/** Score in [-1, 1] */
const validScoreArb = fc.float({ min: -1.0, max: 1.0 });

/** Score outside [-1, 1] */
const outOfRangeScoreArb = fc.oneof(
  fc.float({ min: Math.fround(-100), max: Math.fround(-1.0001) }),
  fc.float({ min: Math.fround(1.0001), max: Math.fround(100) }),
);

/** Valid scheduling suggestion */
const validSuggestionArb = fc.record({
  dayOfWeek: fc.constantFrom('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'),
  timeSlot: fc.constantFrom('09:00', '10:00', '14:00', '18:00', '19:00'),
  predictedAttendance: fc.integer({ min: 0, max: 100 }),
  reasoningFactors: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 5 }),
});

/** Generate sorted-desc suggestions array (1-5 items) */
const validSortedSuggestionsArb = fc
  .array(validSuggestionArb, { minLength: 1, maxLength: 5 })
  .map((suggestions) =>
    [...suggestions].sort((a, b) => b.predictedAttendance - a.predictedAttendance),
  );

// ─── Property 20: No PII in Bedrock Prompts ──────────────────────────────────

describe('Property 20: No PII in Bedrock Prompts', () => {
  it('P20-1: Prompt built from clean title + keywords contains no PII', () => {
    fc.assert(
      fc.property(cleanTitleArb, cleanKeywordsArb, fc.string({ minLength: 0, maxLength: 50 }), (title, keywords, audience) => {
        // Simulate prompt construction (mirrors service.ts)
        const keywordsStr = keywords.join(', ');
        const prompt =
          `Write a compelling event description for an event titled "${title}". ` +
          `Keywords: ${keywordsStr || 'none provided'}. ` +
          `Target audience: ${audience || 'general audience'}. ` +
          `The description should be 100-500 words.`;

        expect(containsPII(prompt)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P20-2: Email addresses are always detected as PII', () => {
    fc.assert(
      fc.property(emailArb, (email) => {
        expect(containsPII(email)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P20-3: UUID member IDs are always detected as PII', () => {
    fc.assert(
      fc.property(uuidArb, (uuid) => {
        expect(containsPII(uuid)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P20-4: Prompt with embedded email is detected as containing PII', () => {
    fc.assert(
      fc.property(emailArb, cleanTitleArb, (email, title) => {
        const promptWithPII = `Event for ${email} titled ${title}`;
        expect(containsPII(promptWithPII)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P20-5: Prompt with embedded memberId is detected as containing PII', () => {
    fc.assert(
      fc.property(uuidArb, cleanTitleArb, (uuid, title) => {
        const promptWithPII = `Member ${uuid} registered for ${title}`;
        expect(containsPII(promptWithPII)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P20-6: stripPII removes emails from feedback text', () => {
    fc.assert(
      fc.property(emailArb, fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !containsPII(s)), (email, text) => {
        const feedback = `${text} contact ${email} for more info`;
        const stripped = stripPII(feedback);
        expect(containsPII(stripped)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P20-7: stripPII removes UUIDs from feedback text', () => {
    fc.assert(
      fc.property(uuidArb, fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !containsPII(s)), (uuid, text) => {
        const feedback = `Member ${uuid} said: ${text}`;
        const stripped = stripPII(feedback);
        expect(stripped).not.toContain(uuid);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 21: AI Response Validation Rejection ───────────────────────────

describe('Property 21: AI Response Validation Rejection', () => {
  it('P21-1: Response with < 100 words is always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 0, maxLength: 99 }),
        (words) => {
          const text = words.join(' ');
          expect(validateDescriptionResponse(text)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P21-2: Response with > 500 words is always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 5 }), { minLength: 501, maxLength: 600 }),
        (words) => {
          const text = words.join(' ');
          expect(validateDescriptionResponse(text)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P21-3: Empty response is always rejected', () => {
    expect(validateDescriptionResponse('')).toBe(false);
    expect(validateDescriptionResponse('   ')).toBe(false);
  });

  it('P21-4: Response with exactly 100-500 words is always accepted', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 500 }),
        (wordCount) => {
          const text = Array.from({ length: wordCount }, (_, i) => `word${i}`).join(' ');
          expect(validateDescriptionResponse(text)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 22: Scheduling Suggestion Range and Ordering ───────────────────

describe('Property 22: Scheduling Suggestion Range and Ordering', () => {
  it('P22-1: Valid suggestions (1-5, sorted, in-range) always pass validation', () => {
    fc.assert(
      fc.property(validSortedSuggestionsArb, (suggestions) => {
        expect(validateSchedulingSuggestions(suggestions)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P22-2: Empty suggestion list is always invalid', () => {
    expect(validateSchedulingSuggestions([])).toBe(false);
  });

  it('P22-3: More than 5 suggestions is always invalid', () => {
    fc.assert(
      fc.property(
        fc.array(validSuggestionArb, { minLength: 6, maxLength: 20 }),
        (suggestions) => {
          const sorted = [...suggestions].sort((a, b) => b.predictedAttendance - a.predictedAttendance);
          expect(validateSchedulingSuggestions(sorted)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P22-4: predictedAttendance outside [0, 100] always fails validation', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.integer({ min: -1000, max: -1 }), fc.integer({ min: 101, max: 1000 })),
        (invalidScore) => {
          const suggestions: ScheduleSuggestion[] = [
            {
              dayOfWeek: 'Monday',
              timeSlot: '14:00',
              predictedAttendance: invalidScore,
              reasoningFactors: ['reason1', 'reason2'],
            },
          ];
          expect(validateSchedulingSuggestions(suggestions)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P22-5: Suggestions with fewer than 2 reasoning factors always fail', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 1 }),
        (factors) => {
          const suggestions: ScheduleSuggestion[] = [
            {
              dayOfWeek: 'Monday',
              timeSlot: '14:00',
              predictedAttendance: 75,
              reasoningFactors: factors,
            },
          ];
          expect(validateSchedulingSuggestions(suggestions)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P22-6: Out-of-order suggestions (not descending) always fail', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        (a, b) => {
          if (a === b) return; // skip equal (ties allowed)
          const lower = Math.min(a, b);
          const higher = Math.max(a, b);
          // ascending order (lower first) is invalid
          const suggestions: ScheduleSuggestion[] = [
            { dayOfWeek: 'Monday', timeSlot: '14:00', predictedAttendance: lower, reasoningFactors: ['r1', 'r2'] },
            { dayOfWeek: 'Tuesday', timeSlot: '14:00', predictedAttendance: higher, reasoningFactors: ['r1', 'r2'] },
          ];
          expect(validateSchedulingSuggestions(suggestions)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 23: Sentiment Score Range Enforcement ──────────────────────────

describe('Property 23: Sentiment Score Range Enforcement', () => {
  it('P23-1: Scores within [-1, 1] are returned unchanged', () => {
    fc.assert(
      fc.property(validScoreArb, (score) => {
        const clamped = clampSentimentScore(score);
        expect(clamped).toBeGreaterThanOrEqual(-1.0);
        expect(clamped).toBeLessThanOrEqual(1.0);
        // Value should be preserved (within float precision)
        expect(Math.abs(clamped - score)).toBeLessThan(1e-10);
      }),
      { numRuns: 100 },
    );
  });

  it('P23-2: Scores below -1.0 are always clamped to -1.0', () => {
    fc.assert(
      fc.property(outOfRangeScoreArb.filter((s) => s < -1.0), (score) => {
        const clamped = clampSentimentScore(score);
        expect(clamped).toBe(-1.0);
      }),
      { numRuns: 100 },
    );
  });

  it('P23-3: Scores above 1.0 are always clamped to 1.0', () => {
    fc.assert(
      fc.property(outOfRangeScoreArb.filter((s) => s > 1.0), (score) => {
        const clamped = clampSentimentScore(score);
        expect(clamped).toBe(1.0);
      }),
      { numRuns: 100 },
    );
  });

  it('P23-4: Clamped score is always in [-1, 1] regardless of input', () => {
    fc.assert(
      fc.property(fc.float({ min: -1000, max: 1000 }), (score) => {
        const clamped = clampSentimentScore(score);
        expect(clamped).toBeGreaterThanOrEqual(-1.0);
        expect(clamped).toBeLessThanOrEqual(1.0);
      }),
      { numRuns: 100 },
    );
  });

  it('P23-5: Clamping is idempotent — clamping twice gives same result', () => {
    fc.assert(
      fc.property(fc.float({ min: -100, max: 100 }), (score) => {
        const once = clampSentimentScore(score);
        const twice = clampSentimentScore(once);
        expect(once).toBe(twice);
      }),
      { numRuns: 100 },
    );
  });

  it('P23-6: Exact boundary values -1.0 and 1.0 are not modified', () => {
    expect(clampSentimentScore(-1.0)).toBe(-1.0);
    expect(clampSentimentScore(1.0)).toBe(1.0);
    expect(clampSentimentScore(0.0)).toBe(0.0);
  });
});
