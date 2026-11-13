import fc from "fast-check";
import { describe, it } from "vitest";
import { istDate, resolveToday } from "@/lib/graveyard/today";

// Feature: dashboard-ui, Property 6: Today_Resolver returns a valid date and falls back correctly
// **Validates: Requirements 4.1, 4.3, 4.4, 4.5**

const IST_OFFSET_MS = 19_800_000;

/** Independent oracle: strict YYYY-MM-DD, and the date survives a Date.UTC round trip. */
function isStrictRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  if (y < 1000) return false; // avoid Date.UTC's 0..99 -> 19xx mapping; such years are out of range anyway
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function inDemoRange(value: string): boolean {
  const y = Number(value.slice(0, 4));
  return y >= 2024 && y <= 2027; // 2024-01-01..2027-12-31 inclusive covers exactly these years
}

const instant = fc.integer({ min: Date.UTC(2023, 0, 1), max: Date.UTC(2028, 11, 31, 23, 59, 59) });

const pad = (n: number, width: number) => String(n).padStart(width, "0");

// Date-looking strings: in/out-of-range years, impossible days (Feb 30, day 0/32), month 0/13, and
// unpadded or whitespace-wrapped variants that must be rejected.
const dateLike = fc
  .record({
    year: fc.integer({ min: 2020, max: 2031 }),
    month: fc.integer({ min: 0, max: 13 }),
    day: fc.integer({ min: 0, max: 32 }),
    style: fc.constantFrom("padded", "padded", "padded", "unpadded", "spaced", "slashes", "suffix"),
  })
  .map(({ year, month, day, style }) => {
    switch (style) {
      case "unpadded":
        return `${year}-${month}-${day}`;
      case "spaced":
        return ` ${year}-${pad(month, 2)}-${pad(day, 2)} `;
      case "slashes":
        return `${pad(day, 2)}/${pad(month, 2)}/${year}`;
      case "suffix":
        return `${year}-${pad(month, 2)}-${pad(day, 2)}T00:00:00Z`;
      default:
        return `${year}-${pad(month, 2)}-${pad(day, 2)}`;
    }
  });

// Boundary and edge dates that matter most.
const edgeDate = fc.constantFrom(
  "2023-12-31",
  "2024-01-01",
  "2024-02-29",
  "2025-02-29",
  "2027-12-31",
  "2028-01-01",
  "2026-02-30",
  "",
);

const rawString = fc.oneof(
  { weight: 4, arbitrary: dateLike },
  { weight: 1, arbitrary: edgeDate },
  { weight: 2, arbitrary: fc.string() },
  { weight: 1, arbitrary: fc.string({ unit: "binary" }) },
);

const raw: fc.Arbitrary<string | string[] | undefined> = fc.oneof(
  { weight: 5, arbitrary: rawString },
  { weight: 3, arbitrary: fc.array(rawString, { minLength: 0, maxLength: 4 }) },
  { weight: 1, arbitrary: fc.constant(undefined) },
);

describe("Property 6: Today_Resolver returns a valid date and falls back correctly", () => {
  it("istDate equals the UTC date of nowMs + 5h30m", () => {
    fc.assert(
      fc.property(instant, (nowMs) => {
        return istDate(nowMs) === new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
      }),
      { numRuns: 200 },
    );
  });

  it("returns a valid date, accepting the first raw value iff it is a strict real date in 2024-01-01..2027-12-31", () => {
    fc.assert(
      fc.property(instant, raw, (nowMs, value) => {
        const result = resolveToday(nowMs, value);
        const first = Array.isArray(value) ? value[0] : value;
        const accepted = typeof first === "string" && isStrictRealDate(first) && inDemoRange(first);

        if (!isStrictRealDate(result.today)) return false;
        if (accepted) return result.today === first && result.override === first;
        const expected = new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
        return result.today === expected && result.override === null;
      }),
      { numRuns: 500 },
    );
  });
});
