// Feature: buyer-voice-call, Property 2: Date_List
// **Validates: Requirements 6.9, 6.10, 11.9**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { agentDate, buildDateList, inPromiseWindow } from "../src/dates";

const DAY_MS = 86_400_000;
// Independent oracle: JS Date, Sunday = 0.
const JS_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const JS_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const RANGE_FIRST = Date.UTC(2024, 3, 1);
const RANGE_LAST = Date.UTC(2035, 2, 31);

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Expected Agent_Date built from JS Date parts only. */
function oracleAgentDate(ms: number): string {
  const d = new Date(ms);
  return `${JS_WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${JS_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const anyDay = fc
  .integer({ min: RANGE_FIRST / DAY_MS, max: RANGE_LAST / DAY_MS })
  .map((epochDay) => epochDay * DAY_MS);

// March of every year in range that has one (2025..2035), so the 31 March cut-off is always exercised.
const marchDay = fc
  .tuple(fc.integer({ min: 2025, max: 2035 }), fc.integer({ min: 1, max: 31 }))
  .map(([year, day]) => Date.UTC(year, 2, day));

const callTodayMs = fc.oneof(anyDay, marchDay);

describe("Property 2: Date_List", () => {
  it("entry k is the Agent_Date of call_today + k, with the JS weekday", () => {
    fc.assert(
      fc.property(callTodayMs, (ms) => {
        const callToday = isoOf(ms);
        const list = buildDateList(callToday);
        expect(list.length).toBeGreaterThan(0);
        list.forEach((entry, k) => {
          const dayMs = ms + k * DAY_MS;
          expect(entry).toBe(agentDate(isoOf(dayMs)));
          expect(entry).toBe(oracleAgentDate(dayMs));
          expect(entry.startsWith(`${JS_WEEKDAYS[new Date(dayMs).getUTCDay()]}, `)).toBe(true);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("a date is listed if and only if inPromiseWindow accepts it", () => {
    fc.assert(
      fc.property(callTodayMs, (ms) => {
        const callToday = isoOf(ms);
        const listed = new Set(buildDateList(callToday));
        let accepted = 0;
        // Scan from before call_today to past the 30-day limit so both edges are probed.
        for (let k = -3; k <= 34; k++) {
          const dayMs = ms + k * DAY_MS;
          const isListed = listed.has(oracleAgentDate(dayMs));
          const inWindow = inPromiseWindow(isoOf(dayMs), callToday);
          expect(isListed).toBe(inWindow);
          if (inWindow) accepted++;
        }
        expect(listed.size).toBe(accepted);
        expect(buildDateList(callToday)).toHaveLength(accepted);
      }),
      { numRuns: 300 },
    );
  });
});
