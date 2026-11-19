import fc from "fast-check";
import { describe, it } from "vitest";
import { inPromiseWindow } from "../src/dates";

// Feature: buyer-voice-call, Property 1: Promise_Window check
// Validates: Requirements 5.11, 11.4

const DAY_MS = 86_400_000;

// Independent oracle: plain JS Date UTC arithmetic, no Engine date helpers.
const pad = (n: number, width: number): string => String(n).padStart(width, "0");

function iso(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;
}

/** Epoch ms of a strictly valid YYYY-MM-DD calendar date, or null. */
function parseStrict(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return iso(ms) === value ? ms : null;
}

/** 31 March closing the financial year (1 Apr to 31 Mar) that contains `ms`. */
function fyEndMs(ms: number): number {
  const d = new Date(ms);
  const year = d.getUTCMonth() >= 3 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  return Date.UTC(year, 2, 31);
}

function oracle(candidate: string, todayMs: number): boolean {
  const c = parseStrict(candidate);
  if (c === null) return false;
  const last = Math.min(todayMs + 30 * DAY_MS, fyEndMs(todayMs));
  return c >= todayMs && c <= last;
}

const FIRST_DAY = Date.UTC(2024, 3, 1);
const LAST_DAY = Date.UTC(2035, 2, 31);
const dayInRange = fc.integer({ min: 0, max: Math.round((LAST_DAY - FIRST_DAY) / DAY_MS) });

// March gets half the weight: it is where the +30 days and the FY end compete.
const marchDate = fc
  .record({ year: fc.integer({ min: 2025, max: 2035 }), day: fc.integer({ min: 1, max: 31 }) })
  .map(({ year, day }) => Date.UTC(year, 2, day));
const callToday = fc.oneof(
  { weight: 1, arbitrary: dayInRange.map((n) => FIRST_DAY + n * DAY_MS) },
  { weight: 1, arbitrary: marchDate },
);

const invalidShapes = fc.oneof(
  fc.string(),
  fc.constantFrom("", "2026-1-5", "26-11-12", "2026/11/12", "2026-11-12T00:00:00Z", " 2026-11-12", "abcd-ef-gh"),
  fc
    .record({
      year: fc.integer({ min: 2024, max: 2036 }),
      month: fc.integer({ min: 0, max: 14 }),
      day: fc.integer({ min: 0, max: 35 }),
    })
    .map(({ year, month, day }) => `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`),
);

const scenario = fc.record({
  todayMs: callToday,
  candidate: fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: -60, max: 60 }).map((offset) => ({ offset, raw: null as string | null })) },
    { weight: 1, arbitrary: invalidShapes.map((raw) => ({ offset: 0, raw: raw as string | null })) },
  ),
});

describe("Property 1: Promise_Window check", () => {
  it("inPromiseWindow is true iff the candidate is a real date in [today, min(today+30, FY end)]", () => {
    fc.assert(
      fc.property(scenario, ({ todayMs, candidate }) => {
        const callTodayIso = iso(todayMs);
        const text = candidate.raw ?? iso(todayMs + candidate.offset * DAY_MS);
        return inPromiseWindow(text, callTodayIso) === oracle(text, todayMs);
      }),
      { numRuns: 500 },
    );
  });
});
