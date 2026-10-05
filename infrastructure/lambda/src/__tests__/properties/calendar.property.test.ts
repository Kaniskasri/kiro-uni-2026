// Feature: clois, Property 28: iCalendar Export Field Fidelity
// Validates: Requirements 20.1, 20.2
// Tests that .ics output always includes required RFC 5545 fields with valid values.

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { generateICS } from '../../calendar/handler';

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Valid UTC ISO 8601 datetime */
const validIsoDateArb = fc
  .date({ min: new Date('2024-01-01T00:00:00Z'), max: new Date('2030-12-31T23:59:59Z') })
  .map((d) => d.toISOString());

/** Valid IANA timezone */
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

/** Non-empty event title */
const eventTitleArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** Ticket ID (UUID-like) */
const ticketIdArb = fc.uuid();

/** Optional description */
const descriptionArb = fc.option(fc.string({ minLength: 1, maxLength: 500 }), { nil: undefined });

/** Optional location string */
const locationArb = fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined });

// ─── ICS field extraction helpers ────────────────────────────────────────────

function extractField(ics: string, fieldName: string): string | null {
  // Unfold the ICS content first (RFC 5545 folding: CRLF + space/tab)
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const lines = unfolded.split('\r\n');

  for (const line of lines) {
    // Match field name with optional parameters (e.g., DTSTART;TZID=...)
    if (line.startsWith(fieldName + ':') || line.startsWith(fieldName + ';')) {
      const colonIdx = line.indexOf(':');
      return colonIdx >= 0 ? line.slice(colonIdx + 1) : null;
    }
  }
  return null;
}

function hasField(ics: string, fieldName: string): boolean {
  return extractField(ics, fieldName) !== null;
}

function extractTZID(ics: string, fieldName: string): string | null {
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  const lines = unfolded.split('\r\n');
  for (const line of lines) {
    if (line.startsWith(fieldName + ';TZID=')) {
      const match = line.match(/;TZID=([^:]+):/);
      return match ? (match[1] ?? null) : null;
    }
  }
  return null;
}

// ─── ICS datetime format validation ──────────────────────────────────────────

function isValidICSDateTime(value: string): boolean {
  // RFC 5545 local time: YYYYMMDDTHHmmSS
  return /^\d{8}T\d{6}$/.test(value);
}

// ─── Property 28: iCalendar Export Field Fidelity ────────────────────────────

describe('Property 28: iCalendar Export Field Fidelity', () => {
  it('P28-1: Output always contains DTSTART with TZID', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        (ticketId, start, end, tz, title) => {
          // Ensure end > start
          const startMs = new Date(start).getTime();
          const endMs = Math.max(startMs + 3600000, new Date(end).getTime());
          const endIso = new Date(endMs).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
          });

          // DTSTART must be present with TZID
          const tzid = extractTZID(ics, 'DTSTART');
          expect(tzid).toBe(tz);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-2: Output always contains DTEND with TZID', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        (ticketId, start, tz, title) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
          });

          const tzid = extractTZID(ics, 'DTEND');
          expect(tzid).toBe(tz);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-3: Output always contains SUMMARY field', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        (ticketId, start, tz, title) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
          });

          expect(hasField(ics, 'SUMMARY')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-4: SUMMARY value matches the event title', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        // Use simple titles without special ICS chars to ease comparison
        fc.string({ minLength: 1, maxLength: 50 }).filter(
          (s) => s.trim().length > 0 && !/[\\;,\n\r]/.test(s),
        ),
        (ticketId, start, tz, title) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
          });

          const summaryValue = extractField(ics, 'SUMMARY');
          expect(summaryValue).toBe(title);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-5: Output always contains valid UID field', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        (ticketId, start, tz, title) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
          });

          const uid = extractField(ics, 'UID');
          expect(uid).toBe(`${ticketId}@clois`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-6: DTSTART value is in RFC 5545 local datetime format (YYYYMMDDTHHmmSS)', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        (ticketId, start, tz, title) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
          });

          // Extract the datetime value after DTSTART;TZID=...:
          const unfolded = ics.replace(/\r\n[ \t]/g, '');
          const lines = unfolded.split('\r\n');
          const dtStartLine = lines.find((l) => l.startsWith('DTSTART;TZID='));
          expect(dtStartLine).toBeTruthy();
          const colonIdx = dtStartLine?.indexOf(':') ?? -1;
          const dtValue = colonIdx >= 0 ? dtStartLine!.slice(colonIdx + 1) : '';
          expect(isValidICSDateTime(dtValue)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-7: Output always wraps in BEGIN:VCALENDAR / END:VCALENDAR', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        (ticketId, start, tz, title) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
          });

          expect(ics).toContain('BEGIN:VCALENDAR');
          expect(ics).toContain('END:VCALENDAR');
          expect(ics).toContain('BEGIN:VEVENT');
          expect(ics).toContain('END:VEVENT');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-8: DESCRIPTION field is included when provided', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !/[\\;,\n\r]/.test(s)),
        (ticketId, start, tz, title, description) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
            description,
          });

          expect(hasField(ics, 'DESCRIPTION')).toBe(true);
          const descValue = extractField(ics, 'DESCRIPTION');
          expect(descValue).toBe(description);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-9: LOCATION field is included when provided', () => {
    fc.assert(
      fc.property(
        ticketIdArb,
        validIsoDateArb,
        validTimezoneArb,
        eventTitleArb,
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !/[\\;,\n\r]/.test(s)),
        (ticketId, start, tz, title, location) => {
          const startMs = new Date(start).getTime();
          const endIso = new Date(startMs + 3600000).toISOString();

          const ics = generateICS({
            uid: `${ticketId}@clois`,
            dtstart: start,
            dtend: endIso,
            timezone: tz,
            summary: title,
            location,
          });

          expect(hasField(ics, 'LOCATION')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P28-10: Valid TZID values are preserved in DTSTART and DTEND', () => {
    fc.assert(
      fc.property(validTimezoneArb, (tz) => {
        const start = '2026-10-15T14:00:00Z';
        const end = '2026-10-15T16:00:00Z';
        const ics = generateICS({
          uid: 'test-uid@clois',
          dtstart: start,
          dtend: end,
          timezone: tz,
          summary: 'Test Event',
        });

        const dtStartTzid = extractTZID(ics, 'DTSTART');
        const dtEndTzid = extractTZID(ics, 'DTEND');
        expect(dtStartTzid).toBe(tz);
        expect(dtEndTzid).toBe(tz);
      }),
      { numRuns: 100 },
    );
  });
});
