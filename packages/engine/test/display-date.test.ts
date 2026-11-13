import { describe, expect, it } from "vitest";
import { formatDisplayDate } from "../src/index";

describe("formatDisplayDate", () => {
  it("drops the leading zero from a single-digit day", () => {
    expect(formatDisplayDate("2026-10-07")).toBe("7 Oct 2026");
  });

  it("keeps a two-digit day", () => {
    expect(formatDisplayDate("2026-10-17")).toBe("17 Oct 2026");
  });

  it("formats the 31 March financial-year end", () => {
    expect(formatDisplayDate("2027-03-31")).toBe("31 Mar 2027");
  });

  it("formats the tax-bomb week date", () => {
    expect(formatDisplayDate("2027-03-10")).toBe("10 Mar 2027");
  });
});
