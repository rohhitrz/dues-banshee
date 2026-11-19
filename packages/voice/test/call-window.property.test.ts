import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { inCallWindow } from "../src/dates";

// Feature: buyer-voice-call, Property 3: Call_Window
// **Validates: Requirements 1.5**

const IST_OFFSET_MS = 19_800_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const RANGE_START = Date.UTC(2024, 0, 1);
const RANGE_END = Date.UTC(2035, 11, 31, 23, 59, 59, 999);

const istParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Independent oracle: Mon-Sat and 10:00 <= time < 19:00 in Asia/Kolkata, read through Intl. */
function oracle(ms: number): boolean {
  const parts = Object.fromEntries(istParts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const weekday = parts.weekday;
  const minuteOfDay = hour * 60 + minute;
  return weekday !== "Sun" && minuteOfDay >= 10 * 60 && minuteOfDay < 19 * 60;
}

/** First and last IST day numbers (days since 1970-01-01 in IST) covering 2024-2035. */
const FIRST_DAY = Math.floor((RANGE_START + IST_OFFSET_MS) / DAY_MS);
const LAST_DAY = Math.floor((RANGE_END + IST_OFFSET_MS) / DAY_MS) - 1;

/** Instant at `minute` past IST midnight of IST day number `day`, plus sub-minute `extraMs`. */
function istInstant(day: number, minute: number, extraMs: number): number {
  return day * DAY_MS - IST_OFFSET_MS + minute * MINUTE_MS + extraMs;
}

const anyInstant = fc.integer({ min: RANGE_START, max: RANGE_END });

const subMinute = fc.integer({ min: 0, max: MINUTE_MS - 1 });

/** Minutes either side of the window edges: 09:59, 10:00, 18:59, 19:00 IST. */
const boundaryMinute = fc.constantFrom(9 * 60 + 59, 10 * 60, 18 * 60 + 59, 19 * 60);

const anyDay = fc.integer({ min: FIRST_DAY, max: LAST_DAY });

/** IST day 0 (1970-01-01) was a Thursday, so IST day 7w + 3 is always a Sunday. */
const sundayDay = fc
  .integer({ min: Math.ceil((FIRST_DAY - 3) / 7), max: Math.floor((LAST_DAY - 3) / 7) })
  .map((w) => w * 7 + 3);

const boundaryInstant = fc
  .tuple(anyDay, boundaryMinute, subMinute)
  .map(([day, minute, extra]) => istInstant(day, minute, extra));

const sundayInstant = fc
  .tuple(sundayDay, fc.integer({ min: 0, max: 24 * 60 - 1 }), subMinute)
  .map(([day, minute, extra]) => istInstant(day, minute, extra));

const sundayBoundaryInstant = fc
  .tuple(sundayDay, boundaryMinute, subMinute)
  .map(([day, minute, extra]) => istInstant(day, minute, extra));

/** Day before and after Sunday at the edges, where a weekday off-by-one would show. */
const sundayNeighbourInstant = fc
  .tuple(sundayDay, fc.constantFrom(-1, 1), boundaryMinute, subMinute)
  .map(([day, shift, minute, extra]) => istInstant(day + shift, minute, extra));

const mixedInstant = fc.oneof(
  { arbitrary: anyInstant, weight: 2 },
  { arbitrary: boundaryInstant, weight: 3 },
  { arbitrary: sundayInstant, weight: 2 },
  { arbitrary: sundayBoundaryInstant, weight: 1 },
  { arbitrary: sundayNeighbourInstant, weight: 2 },
);

describe("Property 3: Call_Window", () => {
  it("matches an Intl Asia/Kolkata oracle for any instant in 2024-2035", () => {
    fc.assert(
      fc.property(mixedInstant, (ms) => {
        expect(inCallWindow(ms)).toBe(oracle(ms));
      }),
      { numRuns: 500 },
    );
  });

  it("matches the oracle on boundary minutes (09:59, 10:00, 18:59, 19:00 IST)", () => {
    fc.assert(
      fc.property(boundaryInstant, (ms) => {
        expect(inCallWindow(ms)).toBe(oracle(ms));
      }),
      { numRuns: 200 },
    );
  });

  it("is always false on Sundays", () => {
    fc.assert(
      fc.property(sundayInstant, (ms) => {
        expect(oracle(ms)).toBe(false);
        expect(inCallWindow(ms)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("anchors the oracle: Thu 2026-11-12 is open 10:00-18:59 IST, closed 09:59 and 19:00", () => {
    // 2026-11-12 is a Thursday; 10:00 IST = 04:30 UTC.
    const at = (h: number, m: number) => Date.UTC(2026, 10, 12, h, m) - IST_OFFSET_MS;
    expect(inCallWindow(at(9, 59))).toBe(false);
    expect(inCallWindow(at(10, 0))).toBe(true);
    expect(inCallWindow(at(18, 59))).toBe(true);
    expect(inCallWindow(at(19, 0))).toBe(false);
    // Sunday 2026-11-15 noon IST is closed.
    expect(inCallWindow(Date.UTC(2026, 10, 15, 12, 0) - IST_OFFSET_MS)).toBe(false);
  });
});
