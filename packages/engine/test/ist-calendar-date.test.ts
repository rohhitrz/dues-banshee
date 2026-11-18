import { describe, expect, it } from "vitest";
import { istCalendarDate } from "../src/calendar-date";

describe("istCalendarDate", () => {
  it("is still the previous IST day one millisecond before 18:30 UTC", () => {
    expect(istCalendarDate(Date.parse("2026-11-11T18:29:59.999Z"))).toEqual("2026-11-11");
  });

  it("rolls to the next IST day at exactly 18:30 UTC (00:00 IST)", () => {
    expect(istCalendarDate(Date.parse("2026-11-11T18:30:00.000Z"))).toEqual("2026-11-12");
  });

  it("rolls from 31 March into the next financial year at 00:00 IST", () => {
    expect(istCalendarDate(Date.parse("2027-03-31T18:30:00.000Z"))).toEqual("2027-04-01");
  });
});
