import { ValidationError } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { parseCreditDays } from "../src/credit-days";

describe("parseCreditDays: accepted inputs (Requirement 6.2)", () => {
  it.each<[string, number | undefined]>([
    ["45", 45],
    ["45 days", 45],
    ["Net 30", 30],
    ["1 day", 1],
    ["NET 15 DAYS", 15],
    ["0", 0],
    ["", undefined],
    ["   ", undefined],
  ])("parses %j as %s", (input, expected) => {
    expect(parseCreditDays(input)).toBe(expected);
  });
});

describe("parseCreditDays: rejected inputs (Requirement 6.2)", () => {
  it.each<[string, string]>([
    ["abc", 'not a number of days: "abc"'],
    ["1234567", 'not a number of days: "1234567"'],
  ])("returns a ValidationError for %j", (input, reason) => {
    const result = parseCreditDays(input);
    expect(result).toBeInstanceOf(ValidationError);
    const error = result as ValidationError;
    expect(error.field).toBe("creditDays");
    expect(error.reason).toBe(reason);
  });
});

describe("parseCreditDays: long input (backtracking guard)", () => {
  const hostile = "1" + " ".repeat(100_000) + "x";

  it("rejects a hostile whitespace run quickly", { timeout: 1000 }, () => {
    const result = parseCreditDays(hostile);
    expect(result).toBeInstanceOf(ValidationError);
    expect((result as ValidationError).reason).toBe(
      `not a number of days: ${JSON.stringify(hostile)}`,
    );
  });

  it("rejects trimmed input longer than 64 characters", { timeout: 1000 }, () => {
    const input = "1" + " ".repeat(70) + "day";
    expect(parseCreditDays(input)).toBeInstanceOf(ValidationError);
  });

  it("collapses inner whitespace runs", () => {
    expect(parseCreditDays("Net \t\u00a0 30  days")).toBe(30);
  });
});
