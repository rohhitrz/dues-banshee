import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  dayDifference,
  fromEpochDay,
  isValidCalendarDate,
  toEpochDay,
} from "../src/calendar-date";
import type { CalendarDate } from "../src/types";

const MIN_EPOCH_DAY = toEpochDay("1900-01-01" as CalendarDate);
const MAX_EPOCH_DAY = toEpochDay("9999-12-31" as CalendarDate);

/** A valid Calendar_Date in 1900-01-01..9999-12-31, built from an epoch day. */
const calendarDate = fc
  .integer({ min: MIN_EPOCH_DAY, max: MAX_EPOCH_DAY })
  .map((epochDay) => fromEpochDay(epochDay));

/** A valid date paired with an offset n that keeps addDays(date, n) inside the range. */
const dateWithInRangeOffset = fc
  .integer({ min: MIN_EPOCH_DAY, max: MAX_EPOCH_DAY })
  .chain((epochDay) =>
    fc.record({
      date: fc.constant(fromEpochDay(epochDay)),
      n: fc.oneof(
        fc.integer({ min: MIN_EPOCH_DAY - epochDay, max: MAX_EPOCH_DAY - epochDay }),
        // Bias towards small offsets, which are the ones that cross month/year boundaries.
        fc.integer({
          min: Math.max(-800, MIN_EPOCH_DAY - epochDay),
          max: Math.min(800, MAX_EPOCH_DAY - epochDay),
        }),
      ),
    }),
  );

describe("calendar-date properties", () => {
  // Feature: legal-engine, Property 1: Calendar arithmetic round trip
  it("Property 1: Calendar arithmetic round trip", () => {
    // **Validates: Requirements 2.1, 3.1, 4.4, 5.10**
    fc.assert(
      fc.property(dateWithInRangeOffset, ({ date, n }) => {
        expect(isValidCalendarDate(date)).toBe(true);
        expect(fromEpochDay(toEpochDay(date))).toBe(date);

        const shifted = addDays(date, n);
        expect(isValidCalendarDate(shifted)).toBe(true);
        expect(dayDifference(date, shifted)).toBe(n);
      }),
    );
  });

  it("Property 1: fromEpochDay(toEpochDay(d)) === d for every generated date", () => {
    // **Validates: Requirements 2.1, 3.1, 4.4, 5.10**
    fc.assert(
      fc.property(calendarDate, (date) => {
        expect(fromEpochDay(toEpochDay(date))).toBe(date);
      }),
    );
  });
});
