import { describe, expect, it } from "vitest";
import { formatINR, parseINR, ValidationError } from "../src/index";

// ---------------------------------------------------------------------------
// Independent BigInt reference. It shares no code with the implementation: rounding is
// (2p + unit) / (2 * unit) with BigInt floor division, and grouping is a regex.
// ---------------------------------------------------------------------------

/** Indian grouping of a non-negative integer: last three digits, then pairs. */
function refGroup(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{2})*\d{3}$)/g, ",");
}

/** Half-up `p / unit` for non-negative BigInts. */
function refRoundedDiv(p: bigint, unit: bigint): bigint {
  return (2n * p + unit) / (2n * unit);
}

/** Renders `hundredths / 100`, dropping trailing zeros and a trailing point. */
function refHundredths(h: bigint): string {
  const frac = h % 100n;
  const whole = h / 100n;
  const fracText = frac === 0n ? "" : `.${frac.toString().padStart(2, "0").replace(/0$/, "")}`;
  return `${refGroup(whole)}${fracText}`;
}

function refShort(paise: number): string {
  const p = BigInt(paise);
  if (p >= 1_000_000_000n) {
    return `₹${refHundredths(refRoundedDiv(p, 10_000_000n))}Cr`;
  }
  if (p >= 10_000_000n) {
    const h = refRoundedDiv(p, 100_000n);
    return h >= 10_000n ? "₹1Cr" : `₹${refHundredths(h)}L`;
  }
  const rupees = refRoundedDiv(p, 100n);
  return rupees >= 100_000n ? "₹1L" : `₹${refGroup(rupees)}`;
}

function refFull(paise: number): string {
  const p = BigInt(paise);
  const paisePart = p % 100n;
  const base = `₹${refGroup(p / 100n)}`;
  return paisePart === 0n ? base : `${base}.${paisePart.toString().padStart(2, "0")}`;
}

const MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991

describe("formatINR near Number.MAX_SAFE_INTEGER", () => {
  it("formats Number.MAX_SAFE_INTEGER in full style", () => {
    // 9007199254740991 paise = 90071992547409 rupees and 91 paise.
    expect(formatINR(MAX, "full")).toBe("₹9,00,71,99,25,47,409.91");
    expect(formatINR(MAX, "full")).toBe(refFull(MAX));
  });

  it("formats Number.MAX_SAFE_INTEGER in short style", () => {
    // 9007199254740991 mod 1e7 = 4740991 < 5e6, so it rounds down to 900719925 hundredths of a crore.
    expect(formatINR(MAX, "short")).toBe("₹90,07,199.25Cr");
    expect(formatINR(MAX, "short")).toBe(refShort(MAX));
  });

  describe("crore tier (unit 1e7 paise, half 5e6)", () => {
    it("rounds the exact half near the top of the safe range up", () => {
      const p = 900719924 * 1e7 + 5e6; // 9007199245000000
      expect(p).toBeLessThanOrEqual(MAX);
      expect(formatINR(p, "short")).toBe("₹90,07,199.25Cr");
    });

    it("rounds one paise below the half near the top of the safe range down", () => {
      const p = 900719924 * 1e7 + 5e6 - 1; // 9007199244999999
      expect(formatINR(p, "short")).toBe("₹90,07,199.24Cr");
    });

    it("rounds the exact half at the bottom of the tier up", () => {
      expect(formatINR(1_005_000_000, "short")).toBe("₹1.01Cr");
      expect(formatINR(1_004_999_999, "short")).toBe("₹1Cr");
    });

    it("strips one trailing zero in the second decimal", () => {
      expect(formatINR(1_205_000_000, "short")).toBe("₹1.21Cr");
      expect(formatINR(1_204_999_999, "short")).toBe("₹1.2Cr");
    });
  });

  describe("lakh tier (unit 1e5 paise, half 5e4)", () => {
    it("rounds the exact half at the bottom of the tier up", () => {
      expect(formatINR(10_050_000, "short")).toBe("₹1.01L");
      expect(formatINR(10_049_999, "short")).toBe("₹1L");
    });

    it("rounds the exact half in the middle of the tier up", () => {
      expect(formatINR(41_250_000, "short")).toBe("₹4.13L");
      expect(formatINR(41_249_999, "short")).toBe("₹4.12L");
    });

    it("rounds the exact half at the top of the tier", () => {
      expect(formatINR(999_850_000, "short")).toBe("₹99.99L");
      expect(formatINR(999_849_999, "short")).toBe("₹99.98L");
    });

    it("bumps 100L to ₹1Cr and keeps 99.99L just below the half", () => {
      expect(formatINR(999_950_000, "short")).toBe("₹1Cr");
      expect(formatINR(999_949_999, "short")).toBe("₹99.99L");
    });
  });

  describe("rupee tier (unit 100 paise, half 50)", () => {
    it("rounds the exact half at the bottom of the tier up", () => {
      expect(formatINR(50, "short")).toBe("₹1");
      expect(formatINR(49, "short")).toBe("₹0");
    });

    it("rounds the exact half in the middle of the tier up", () => {
      expect(formatINR(12_350, "short")).toBe("₹124");
      expect(formatINR(12_349, "short")).toBe("₹123");
    });

    it("bumps ₹1,00,000 to ₹1L and keeps ₹99,999 just below the half", () => {
      expect(formatINR(9_999_950, "short")).toBe("₹1L");
      expect(formatINR(9_999_949, "short")).toBe("₹99,999");
    });
  });

  describe("agrees with an independent BigInt half-up reference", () => {
    const cases: number[] = [
      MAX,
      MAX - 1,
      MAX - 4_740_991, // multiple of 1e7
      900719924 * 1e7 + 5e6, // crore half, rounds up
      900719924 * 1e7 + 5e6 - 1, // crore half minus one, rounds down
      900719923 * 1e7 + 5e6,
      900719923 * 1e7 + 5e6 - 1,
      1_000_000_000,
      999_950_000,
      999_949_999,
      10_000_000,
      9_999_950,
      9_999_949,
      41_249_999,
      41_250_000,
      12_349,
      12_350,
      0,
    ];

    it.each(cases)("short style for %i", (p) => {
      expect(formatINR(p, "short")).toBe(refShort(p));
    });

    it.each(cases)("full style for %i", (p) => {
      expect(formatINR(p, "full")).toBe(refFull(p));
    });
  });
});

/** Runs `fn`, asserts it throws a ValidationError, and returns that error. */
function catchValidationError(fn: () => unknown): ValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error("expected a ValidationError but nothing was thrown");
}

describe("formatINR examples", () => {
  it("formats ₹4,12,000 in both styles", () => {
    expect(formatINR(41_200_000, "full")).toBe("₹4,12,000");
    expect(formatINR(41_200_000, "short")).toBe("₹4.12L");
  });

  it("formats zero", () => {
    expect(formatINR(0, "full")).toBe("₹0");
    expect(formatINR(0, "short")).toBe("₹0");
  });

  it("shows two-digit paise in full style only when non-zero", () => {
    expect(formatINR(41_200_050, "full")).toBe("₹4,12,000.50");
    expect(formatINR(5, "full")).toBe("₹0.05");
    expect(formatINR(41_200_000, "full")).toBe("₹4,12,000");
  });

  it("formats crore amounts", () => {
    expect(formatINR(1_250_000_000, "short")).toBe("₹1.25Cr");
    expect(formatINR(1_250_000_000, "full")).toBe("₹1,25,00,000");
  });

  it("drops trailing zeros in short style", () => {
    expect(formatINR(40_000_000, "short")).toBe("₹4L");
    expect(formatINR(41_000_000, "short")).toBe("₹4.1L");
  });

  it("bumps a rounded-up 100 units to the next unit", () => {
    expect(formatINR(999_950_000, "short")).toBe("₹1Cr");
    expect(formatINR(9_999_950, "short")).toBe("₹1L");
  });

  describe("Indian digit grouping (checked through full style)", () => {
    it.each([
      [99_900, "₹999"],
      [100_000, "₹1,000"],
      [9_999_900, "₹99,999"],
      [10_000_000, "₹1,00,000"],
      [12_345_678_900, "₹12,34,56,789"],
      [123_456_789_000, "₹1,23,45,67,890"],
    ])("groups %i paise as %s", (paise, expected) => {
      expect(formatINR(paise, "full")).toBe(expected);
    });
  });
});

describe("parseINR examples", () => {
  it.each([
    ["₹4,12,000", 41_200_000],
    ["₹4,12,000.50", 41_200_050],
    ["₹0", 0],
    ["₹999", 99_900],
    ["₹1,000", 100_000],
    ["₹1,00,000", 10_000_000],
    ["₹0.05", 5],
  ])("parses %s as %i paise", (text, paise) => {
    expect(parseINR(text)).toBe(paise);
  });

  it("rejects western grouping and names the offending input", () => {
    expect(() => parseINR("₹412,000")).toThrow(ValidationError);
    const error = catchValidationError(() => parseINR("₹412,000"));
    expect(error.message).toContain("₹412,000");
    expect(error.field).toBe("text");
  });

  it.each([
    "4,12,000",
    "₹04",
    "₹4,12,000.00",
    "₹4,12,000.5",
    "₹4.12L",
    "₹1.25Cr",
    "₹ 4,12,000",
    "",
  ])("rejects non-canonical text %j", (text) => {
    expect(() => parseINR(text)).toThrow(ValidationError);
  });
});

describe("formatINR validation", () => {
  const invalid: [string, number][] = [
    ["a negative number", -1],
    ["a fractional number", 1.5],
    ["NaN", Number.NaN],
    ["+Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
  ];

  describe.each(["full", "short"] as const)("%s style", (style) => {
    it.each(invalid)("throws ValidationError for %s", (_label, paise) => {
      const error = catchValidationError(() => formatINR(paise, style));
      expect(error.field).toBe("paise");
    });
  });
});
