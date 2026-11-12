import { ValidationError } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { parseAmountLenient } from "../src/amount";

const EMPTY = "is empty";
const UNRECOGNISED = "not a recognised amount";
const CREDIT = "Credit balance (Cr) is not a receivable";
const PRECISION = "more precise than one paisa";
const TOO_BIG = "above the largest supported amount (9007199254740991 paise)";

describe("parseAmountLenient: accepted inputs (Requirement 3.6)", () => {
  it.each<[string, number]>([
    ["500", 50_000],
    ["500.00", 50_000],
    ["500.5", 50_050],
    ["0.01", 1],
    ["0", 0],
    ["0.50", 50],
    ["4,12,000", 41_200_000],
    ["412,000", 41_200_000],
    ["₹4,12,000", 41_200_000],
    ["₹4,12,000.50", 41_200_050],
    ["Rs. 500", 50_000],
    ["rs500", 50_000],
    ["INR 500", 50_000],
    ["INR 1,250,000.75", 125_000_075],
    ["500/-", 50_000],
    ["₹4,12,000/-", 41_200_000],
    ["4,12,000.00 Dr", 41_200_000],
    ["4.12 L", 41_200_000],
    ["4.12 lakh", 41_200_000],
    ["4.12 lakhs", 41_200_000],
    ["4.12 lac", 41_200_000],
    ["4.12 lacs", 41_200_000],
    ["₹4.12L", 41_200_000],
    ["4.1234567 L", 41_234_567],
    ["4.12 crore", 4_120_000_000],
    ["4.12 crores", 4_120_000_000],
    ["1,250 crore", 1_250_000_000_000],
    ["  500  ", 50_000],
    ["90071992547409.91", 9_007_199_254_740_991],
  ])("parses %j as %i paise", (input, paise) => {
    expect(parseAmountLenient(input)).toBe(paise);
  });
});

describe("parseAmountLenient: rejected inputs (Requirement 3.7)", () => {
  it.each<[string, string]>([
    // empty or whitespace only
    ["", EMPTY],
    ["   ", EMPTY],
    // negative
    ["-500", UNRECOGNISED],
    ["₹-500", UNRECOGNISED],
    ["(500)", UNRECOGNISED],
    // credit balance
    ["4,12,000.00 Cr", CREDIT],
    ["4.12 Cr", CREDIT],
    // more than one-paisa precision after scaling
    ["500.001", PRECISION],
    ["4.12345678 L", PRECISION],
    // malformed grouping
    ["4,1,2000", UNRECOGNISED],
    ["500,00", UNRECOGNISED],
    ["4 12 000", UNRECOGNISED],
    // a point with no digit on one side
    ["500.", UNRECOGNISED],
    [".50", UNRECOGNISED],
    // a prefix with no number
    ["Rs", UNRECOGNISED],
    // repeated prefix, unit or suffix
    ["₹ ₹500", UNRECOGNISED],
    ["4 L crore", UNRECOGNISED],
    ["500/-/-", UNRECOGNISED],
    // grouped numbers can't start with a zero
    ["00,000", UNRECOGNISED],
    ["01,000", UNRECOGNISED],
    ["012,000", UNRECOGNISED],
    ["0,12,000", UNRECOGNISED],
    // letters other than prefixes, units and Dr
    ["500 USD", UNRECOGNISED],
    ["abc", UNRECOGNISED],
    ["1.5 K", UNRECOGNISED],
    // above MAX_SAFE
    ["90071992547409.92", TOO_BIG],
    ["1,00,00,000 crore", TOO_BIG],
  ])("rejects %j with %s", (input, reason) => {
    const result = parseAmountLenient(input);
    expect(result).toBeInstanceOf(ValidationError);
    const error = result as ValidationError;
    expect(error.field).toBe("amount");
    expect(error.reason).toBe(`${reason}: ${JSON.stringify(input)}`);
  });
});

describe("parseAmountLenient: long input (backtracking guard)", () => {
  const hostile = "1" + " ".repeat(100_000) + "x";

  it("rejects a hostile whitespace run quickly", { timeout: 1000 }, () => {
    const result = parseAmountLenient(hostile);
    expect(result).toBeInstanceOf(ValidationError);
    expect((result as ValidationError).reason).toBe(`${UNRECOGNISED}: ${JSON.stringify(hostile)}`);
  });

  it("rejects trimmed input longer than 64 characters", { timeout: 1000 }, () => {
    const input = "1".repeat(65);
    const result = parseAmountLenient(input);
    expect(result).toBeInstanceOf(ValidationError);
    expect((result as ValidationError).reason).toBe(`${UNRECOGNISED}: ${JSON.stringify(input)}`);
  });

  it("accepts 64 characters and collapses inner whitespace runs", () => {
    expect(parseAmountLenient("1".repeat(14))).toBe(Number("1".repeat(14) + "00"));
    expect(parseAmountLenient("₹ \u00a0 500")).toBe(50_000);
    expect(parseAmountLenient("4.12 \t\u00a0 lakh")).toBe(41_200_000);
  });
});
