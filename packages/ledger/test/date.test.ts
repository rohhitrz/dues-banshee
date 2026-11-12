import { ValidationError } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { EXCEL_SERIAL_MAX, EXCEL_SERIAL_MIN, parseDateLenient } from "../src/date";

const EMPTY = "is empty";
const NOT_REAL_DAY = "not a real calendar day";
const UNRECOGNISED = "not a recognised date";
const TWO_DIGIT_YEAR =
  "two-digit year; write the year in full or use a month name (02-Sep-26)";
const SERIAL_RANGE = "Excel serial outside 36526–73050 (2000–2099)";

describe("parseDateLenient: accepted inputs (Requirement 4.5)", () => {
  it.each<[string, string]>([
    ["2026-09-02", "2026-09-02"],
    ["02/09/2026", "2026-09-02"],
    ["2/9/2026", "2026-09-02"],
    ["02-09-2026", "2026-09-02"],
    ["02.09.2026", "2026-09-02"],
    ["02-Sep-2026", "2026-09-02"],
    ["2-sep-2026", "2026-09-02"],
    ["2-Sep-26", "2026-09-02"],
    ["02-SEP-26", "2026-09-02"],
    ["29-Feb-28", "2028-02-29"],
    ["09/02/2026", "2026-02-09"],
    ["29/02/2028", "2028-02-29"],
    ["46267", "2026-09-02"],
    ["46312", "2026-10-17"],
    ["46812", "2028-02-29"],
    ["36526", "2000-01-01"],
    ["73050", "2099-12-31"],
    [" 02/09/2026 ", "2026-09-02"],
  ])("parses %j as %s", (input, expected) => {
    expect(parseDateLenient(input)).toBe(expected);
  });
});

describe("parseDateLenient: rejected inputs (Requirement 4.6)", () => {
  it.each<[string, string]>([
    // empty
    ["", EMPTY],
    // a day that does not exist
    ["31/02/2026", NOT_REAL_DAY],
    ["29/02/2026", NOT_REAL_DAY],
    ["2026-02-30", NOT_REAL_DAY],
    ["12/31/2026", NOT_REAL_DAY],
    ["13/13/2026", NOT_REAL_DAY],
    ["29-Feb-26", NOT_REAL_DAY],
    // mixed separators
    ["02/09-2026", UNRECOGNISED],
    // numeric date with a two-digit year
    ["02/09/26", TWO_DIGIT_YEAR],
    ["02-09-26", TWO_DIGIT_YEAR],
    ["02.09.26", TWO_DIGIT_YEAR],
    // month-name date with a three-digit year
    ["2-Sep-226", UNRECOGNISED],
    // another layout
    ["Sep 2, 2026", UNRECOGNISED],
    // Excel serial out of range
    ["36525", SERIAL_RANGE],
    ["73051", SERIAL_RANGE],
    ["2026", SERIAL_RANGE],
    ["60", SERIAL_RANGE],
    ["0", SERIAL_RANGE],
    // fractional serial
    ["46267.5", UNRECOGNISED],
  ])("rejects %j with %s", (input, reason) => {
    const result = parseDateLenient(input);
    expect(result).toBeInstanceOf(ValidationError);
    const error = result as ValidationError;
    expect(error.field).toBe("date");
    expect(error.reason).toBe(`${reason}: ${JSON.stringify(input)}`);
  });

  it("returns the error instead of throwing it", () => {
    expect(() => parseDateLenient("31/02/2026")).not.toThrow();
    expect(() => parseDateLenient("")).not.toThrow();
    expect(() => parseDateLenient("Sep 2, 2026")).not.toThrow();
  });
});

describe("Excel serial bounds", () => {
  it("exports the serials for 2000-01-01 and 2099-12-31", () => {
    expect(EXCEL_SERIAL_MIN).toBe(36526);
    expect(EXCEL_SERIAL_MAX).toBe(73050);
  });
});
