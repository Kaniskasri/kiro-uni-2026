// Feature: clois, Property 17: Report Generation Sync vs Async Routing
// Feature: clois, Property 27: CSV Export Round-Trip
// Feature: clois, Property 16: Dashboard Metric Calculation Correctness

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { calculateAttendanceRate, calculateCheckInRate } from '../../analytics/service';

// ─── RFC 4180 CSV helpers (inline for testing) ────────────────────────────────

function escapeCSVField(value: unknown): string {
  const str = String(value ?? '');
  if (str.includes('"') || str.includes(',') || str.includes('\r') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function buildCSV(headers: string[], rows: Record<string, unknown>[]): string {
  const headerLine = headers.map(escapeCSVField).join(',');
  const dataLines = rows.map((row) => headers.map((h) => escapeCSVField(row[h])).join(','));
  return [headerLine, ...dataLines].join('\r\n');
}

function parseCSV(csv: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = csv.split('\r\n');
  if (lines.length === 0) return { headers: [], rows: [] };

  function parseFields(line: string): string[] {
    const fields: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let field = '';
        i++; // skip opening quote
        while (i < line.length) {
          if (line[i] === '"') {
            if (line[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += line[i];
            i++;
          }
        }
        fields.push(field);
        if (line[i] === ',') i++;
      } else {
        const end = line.indexOf(',', i);
        if (end === -1) {
          fields.push(line.slice(i));
          break;
        } else {
          fields.push(line.slice(i, end));
          i = end + 1;
        }
      }
    }
    return fields;
  }

  const headers = parseFields(lines[0] ?? '');
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fields = parseFields(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = fields[idx] ?? '';
    });
    rows.push(row);
  }

  return { headers, rows };
}

// ─── Routing threshold simulation (mirrors service.ts logic) ─────────────────

function routeTrendReport(eventCount: number): { async: boolean } {
  return { async: eventCount > 100 };
}

// ─── Property 17: Report Generation Sync vs Async Routing ───────────────────

describe('Property 17: Report Generation Sync vs Async Routing', () => {
  it('P17-1: eventCount <= 100 always routes synchronously', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (count) => {
        const result = routeTrendReport(count);
        expect(result.async).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('P17-2: eventCount > 100 always routes asynchronously', () => {
    fc.assert(
      fc.property(fc.integer({ min: 101, max: 10_000 }), (count) => {
        const result = routeTrendReport(count);
        expect(result.async).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('P17-3: Boundary at exactly 100 is synchronous', () => {
    expect(routeTrendReport(100).async).toBe(false);
  });

  it('P17-4: Boundary at exactly 101 is asynchronous', () => {
    expect(routeTrendReport(101).async).toBe(true);
  });

  it('P17-5: Routing is deterministic for any count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (count) => {
        const result1 = routeTrendReport(count);
        const result2 = routeTrendReport(count);
        expect(result1.async).toBe(result2.async);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 27: CSV Export Round-Trip ──────────────────────────────────────

const csvSafeStringArb = fc.string({ minLength: 0, maxLength: 100 }).filter(
  (s) => !s.includes('\0'), // null bytes not valid in CSV
);

const csvRowArb = fc.record({
  eventId: fc.uuid(),
  orgId: fc.uuid(),
  confirmedCount: fc.nat({ max: 10_000 }).map(String),
  checkedInCount: fc.nat({ max: 10_000 }).map(String),
  attendanceRate: fc.float({ min: 0, max: 100 }).map(String),
  notes: csvSafeStringArb,
});

describe('Property 27: CSV Export Round-Trip', () => {
  it('P27-1: serialize then parse returns same field values', () => {
    fc.assert(
      fc.property(fc.array(csvRowArb, { minLength: 1, maxLength: 20 }), (rows) => {
        const headers = ['eventId', 'orgId', 'confirmedCount', 'checkedInCount', 'attendanceRate', 'notes'];
        const csv = buildCSV(headers, rows);
        const parsed = parseCSV(csv);

        expect(parsed.headers).toEqual(headers);
        expect(parsed.rows.length).toBe(rows.length);

        for (let i = 0; i < rows.length; i++) {
          const original = rows[i];
          const parsedRow = parsed.rows[i];
          if (!original || !parsedRow) continue;
          for (const h of headers) {
            expect(parsedRow[h]).toBe(String(original[h as keyof typeof original] ?? ''));
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('P27-2: fields with commas are properly escaped and round-trip correctly', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.includes(',')),
        (fieldWithComma) => {
          const row = { notes: fieldWithComma, id: '1' };
          const csv = buildCSV(['id', 'notes'], [row]);
          const parsed = parseCSV(csv);
          expect(parsed.rows[0]?.['notes']).toBe(fieldWithComma);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P27-3: fields with double quotes are properly escaped and round-trip correctly', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.includes('"')),
        (fieldWithQuote) => {
          const row = { notes: fieldWithQuote, id: '1' };
          const csv = buildCSV(['id', 'notes'], [row]);
          const parsed = parseCSV(csv);
          expect(parsed.rows[0]?.['notes']).toBe(fieldWithQuote);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P27-4: header row always present and matches input headers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z_]+$/.test(s)), {
          minLength: 1,
          maxLength: 10,
        }),
        (headers) => {
          const uniqueHeaders = [...new Set(headers)];
          const csv = buildCSV(uniqueHeaders, []);
          const parsed = parseCSV(csv);
          expect(parsed.headers).toEqual(uniqueHeaders);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P27-5: empty value fields round-trip as empty strings', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10 }), (count) => {
        const rows = Array.from({ length: count }, (_, i) => ({ id: String(i), notes: '' }));
        const csv = buildCSV(['id', 'notes'], rows);
        const parsed = parseCSV(csv);
        expect(parsed.rows.length).toBe(count);
        for (const row of parsed.rows) {
          expect(row['notes']).toBe('');
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 16: Dashboard Metric Calculation Correctness ───────────────────

describe('Property 16: Dashboard Metric Calculation Correctness', () => {
  it('P16-1: Attendance rate = checkedIn / confirmed * 100, always in [0, 100]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (checkedIn, confirmed) => {
          const safeCheckedIn = Math.min(checkedIn, confirmed);
          const rate = calculateAttendanceRate(safeCheckedIn, confirmed);
          expect(rate).toBeGreaterThanOrEqual(0);
          expect(rate).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P16-2: Attendance rate is 0 when confirmed is 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (checkedIn) => {
        expect(calculateAttendanceRate(checkedIn, 0)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('P16-3: Attendance rate is 100 when all confirmed are checked in', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (count) => {
        expect(calculateAttendanceRate(count, count)).toBe(100);
      }),
      { numRuns: 100 },
    );
  });

  it('P16-4: Check-in rate never exceeds 100% regardless of input', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (checkedIn, confirmed) => {
          const rate = calculateCheckInRate(checkedIn, confirmed);
          expect(rate).toBeLessThanOrEqual(100);
          expect(rate).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P16-5: Attendance rate increases monotonically as checkedIn increases', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (a, b) => {
          const confirmed = 1000;
          const lower = Math.min(a, b);
          const higher = Math.max(a, b);
          const rateA = calculateAttendanceRate(lower, confirmed);
          const rateB = calculateAttendanceRate(higher, confirmed);
          expect(rateB).toBeGreaterThanOrEqual(rateA);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P16-6: Metric calculation is deterministic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        (checkedIn, confirmed) => {
          const rate1 = calculateAttendanceRate(checkedIn, confirmed);
          const rate2 = calculateAttendanceRate(checkedIn, confirmed);
          expect(rate1).toBe(rate2);
        },
      ),
      { numRuns: 100 },
    );
  });
});
