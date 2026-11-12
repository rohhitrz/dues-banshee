import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ValidationError, formatINR, parseINR } from "../src/index";
import { arbPaise } from "./arbitraries";

// ---------------------------------------------------------------------------
// Independent oracles (not the implementation's own helpers)
// ---------------------------------------------------------------------------

/** Canonical Full_Format, written out separately from the one in src/format-inr.ts. */
const CANONICAL_FULL = /^₹(0|[1-9]\d{0,2}|[1-9]\d?(?:,\d{2})*,\d{3})(?:\.(\d{2}))?$/;

describe("format-inr properties", () => {
  // Feature: legal-engine, Property 17: Full format round trip from paise
  it("Property 17: Full format round trip from paise", () => {
    // **Validates: Requirements 7.1, 7.6, 7.9**
    fc.assert(
      fc.property(arbPaise, (paise) => {
        const text = formatINR(paise, "full");

        // The text is canonical Full_Format, and the paise group is never "00".
        const match = CANONICAL_FULL.exec(text);
        expect(match).not.toBeNull();
        expect(match?.[2]).not.toBe("00");

        // parseINR inverts formatINR exactly.
        expect(parseINR(text)).toBe(paise);
      }),
    );
  });

  // Feature: legal-engine, Property 17: Full format round trip from paise
  it("Property 17: covers 0, MAX_SAFE_INTEGER and MAX_SAFE_INTEGER - 1 explicitly", () => {
    // **Validates: Requirements 7.1, 7.6, 7.9**
    fc.assert(
      fc.property(fc.constantFrom(0, 1, 99, 100, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER), (paise) => {
        const text = formatINR(paise, "full");
        expect(CANONICAL_FULL.test(text)).toBe(true);
        expect(parseINR(text)).toBe(paise);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18 helpers: canonical Full_Format text built from structure, not via formatINR
// ---------------------------------------------------------------------------

const MAX_SAFE_PAISE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Indian grouping of a non-negative BigInt: a comma after a digit when an odd number (>= 3) of digits follows. */
function groupRupeesIndependently(rupees: bigint): string {
  return rupees.toString().replace(/(\d)(?=(\d\d)+\d$)/g, "$1,");
}

/** A canonical Full_Format string whose value is at most MAX_SAFE_INTEGER paise. `.00` is never produced. */
const arbCanonicalFullText: fc.Arbitrary<string> = fc
  .tuple(
    fc.oneof(
      { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: MAX_SAFE_PAISE_BIGINT / 100n }) },
      { weight: 2, arbitrary: fc.bigInt({ min: 0n, max: 99_999_999n }) },
      { weight: 1, arbitrary: fc.constantFrom(0n, 999n, 1_000n, 99_999n, 100_000n, 9_999_999n, 10_000_000n) },
    ),
    fc.oneof({ weight: 1, arbitrary: fc.constant(null) }, { weight: 2, arbitrary: fc.integer({ min: 1, max: 99 }) }),
  )
  .filter(([rupees, paise]) => rupees * 100n + BigInt(paise ?? 0) <= MAX_SAFE_PAISE_BIGINT)
  .map(([rupees, paise]) => {
    const base = `₹${groupRupeesIndependently(rupees)}`;
    return paise === null ? base : `${base}.${String(paise).padStart(2, "0")}`;
  });

describe("format-inr properties: parse then format", () => {
  // Feature: legal-engine, Property 18: Full format round trip from text
  it("Property 18: Full format round trip from text (strings produced by formatINR)", () => {
    // **Validates: Requirements 7.10**
    fc.assert(
      fc.property(arbPaise, (paise) => {
        const text = formatINR(paise, "full");
        expect(formatINR(parseINR(text), "full")).toBe(text);
      }),
    );
  });

  // Feature: legal-engine, Property 18: Full format round trip from text
  it("Property 18: Full format round trip from text (canonical strings built from structure)", () => {
    // **Validates: Requirements 7.10**
    fc.assert(
      fc.property(arbCanonicalFullText, (text) => {
        expect(CANONICAL_FULL.test(text)).toBe(true);
        expect(formatINR(parseINR(text), "full")).toBe(text);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19 helpers: Short_Format checks done with exact BigInt arithmetic, not the implementation's helpers
// ---------------------------------------------------------------------------
const SHORT_PATTERN = /^₹([0-9,]+)(?:\.(\d{1,2}))?(Cr|L)?$/;
const INDIAN_GROUPED_INTEGER = /^(0|[1-9]\d{0,2}|[1-9]\d?(,\d{2})*,\d{3})$/;
/** Paise per displayed unit (1 crore, 1 lakh, 1 rupee) and half of the smallest displayed step. */
const SHORT_UNITS = {
  Cr: { unitPaise: 1_000_000_000n, halfStepPaise: 5_000_000n },
  L: { unitPaise: 10_000_000n, halfStepPaise: 50_000n },
  none: { unitPaise: 100n, halfStepPaise: 50n },
} as const;

/** The tier the short text must show, decided from the rounded value (exact half boundaries round up). */
function expectedShortTier(p: bigint): "Cr" | "L" | "none" {
  if (p >= 999_950_000n) {
    return "Cr"; // at least one crore, or rounds to 100 lakh
  }
  if (p >= 9_999_950n) {
    return "L"; // rounds to at least one lakh, below the crore tier
  }
  return "none";
}

function checkShortFormat(p: number): void {
  const text = formatINR(p, "short");
  const big = BigInt(p);

  const match = SHORT_PATTERN.exec(text);
  expect(match, text).not.toBeNull();
  const integerText = match?.[1] ?? "";
  const fractionText = match?.[2];
  const tier: keyof typeof SHORT_UNITS = (match?.[3] as "Cr" | "L" | undefined) ?? "none";

  // Tier follows the rounded value.
  expect(tier, text).toBe(expectedShortTier(big));

  // Integer part is Indian-grouped; no decimals at all for whole rupees; no trailing zero after the point.
  expect(INDIAN_GROUPED_INTEGER.test(integerText), text).toBe(true);
  if (tier === "none") {
    expect(text.includes("."), text).toBe(false);
  }
  if (fractionText !== undefined) {
    expect(fractionText.length, text).toBeLessThanOrEqual(2);
    expect(fractionText.endsWith("0"), text).toBe(false);
  }
  expect(text.endsWith("."), text).toBe(false);

  // Numeric value, as exact paise, is within half a display step of p.
  const { unitPaise, halfStepPaise } = SHORT_UNITS[tier];
  const fractionHundredths = BigInt((fractionText ?? "").padEnd(2, "0") || "0");
  const valuePaise = BigInt(integerText.replace(/,/g, "")) * unitPaise + (fractionHundredths * unitPaise) / 100n;
  const diff = valuePaise > big ? valuePaise - big : big - valuePaise;
  expect(diff <= halfStepPaise, `${text} vs ${p}: diff ${diff} > ${halfStepPaise}`).toBe(true);
}

describe("format-inr properties: short format", () => {
  // Feature: legal-engine, Property 19: Short format tier and accuracy
  it("Property 19: Short format tier and accuracy", () => {
    // **Validates: Requirements 7.2**
    fc.assert(
      fc.property(arbPaise, (paise) => {
        checkShortFormat(paise);
      }),
    );
  });

  // Feature: legal-engine, Property 19: Short format tier and accuracy
  it("Property 19: tier boundaries and extremes", () => {
    // **Validates: Requirements 7.2**
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, "₹0"],
      [9_999_949, "₹99,999"],
      [9_999_950, "₹1L"],
      [999_949_999, "₹99.99L"],
      [999_950_000, "₹1Cr"],
      [Number.MAX_SAFE_INTEGER, "₹90,07,199.25Cr"],
    ];
    for (const [paise, expected] of cases) {
      expect(formatINR(paise, "short")).toBe(expected);
      checkShortFormat(paise);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 20 helpers: bad numbers for formatINR, and non-canonical text for parseINR
// ---------------------------------------------------------------------------

/** True when `s` is not canonical Full_Format by the independent oracle (shape, or a "00" paise group). */
function isNonCanonical(s: string): boolean {
  const match = CANONICAL_FULL.exec(s);
  return match === null || match[2] === "00";
}

/** Values that are not a non-negative safe integer number. Non-number types are cast through unknown. */
const arbBadPaise: fc.Arbitrary<number> = fc
  .oneof(
    // Negative integers.
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 }),
    fc.constantFrom(-1, -100, Number.MIN_SAFE_INTEGER, -Number.MAX_VALUE),
    // Fractional numbers, positive and negative.
    fc.double({ noInteger: true, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: 1e6, noInteger: true, noNaN: true }),
    fc.constantFrom(0.5, 1.5, 99.99, -0.5),
    // NaN and infinities.
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    // Above MAX_SAFE_INTEGER.
    fc.constantFrom(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2, Number.MAX_VALUE),
    fc.double({ min: Number.MAX_SAFE_INTEGER + 1, max: Number.MAX_VALUE, noNaN: true }),
    // Non-number types.
    fc
      .oneof(
        fc.string(),
        fc.integer().map(String),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.array(fc.integer()),
        fc.constant({}),
        fc.constant([5]),
      )
      .map((v) => v as unknown as number),
  )
  .filter((v) => !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0)));

/** Splits canonical Full_Format text into its rupee digits (with commas) and optional ".xx" paise part. */
function splitFull(text: string): { rupees: string; paise: string } {
  const match = /^₹([\d,]+)(\.\d{2})?$/.exec(text);
  return { rupees: match?.[1] ?? "", paise: match?.[2] ?? "" };
}

/** Rupees re-grouped in threes (western style). */
function westernGrouping(rupees: string): string {
  return rupees.replace(/,/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const arbWhitespace = fc.constantFrom(" ", "  ", "\t", "\n", "\u00a0", "\u2009");
const arbGarbage: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: "binary", minLength: 1, maxLength: 4 }),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 4 }),
  fc.constantFrom("\u0966", "\u0967", "\uff11", "\u200b", "\ufeff", "\ud83d", "₹", "Rs", "INR", "%", "-", "+", "e5"),
);

/** Valid formatINR(x, "full") output with one mutation applied. May accidentally still be canonical. */
const arbMutatedFullText: fc.Arbitrary<string> = arbPaise
  .map((paise) => formatINR(paise, "full"))
  .chain((text) => {
    const { rupees, paise } = splitFull(text);
    const frac = paise === "" ? "50" : paise.slice(1);
    return fc.oneof(
      // Drop the ₹.
      fc.constant(text.slice(1)),
      // Western grouping.
      fc.constant(`₹${westernGrouping(rupees)}${paise}`),
      // Leading zeros on the rupee digits.
      fc.integer({ min: 1, max: 3 }).map((k) => `₹${"0".repeat(k)}${rupees}${paise}`),
      // Appended ".00" (also doubles up an existing paise part).
      fc.constant(`${text}.00`),
      fc.constant(`₹${rupees}.00`),
      // One paise digit.
      fc.integer({ min: 0, max: 9 }).map((d) => `₹${rupees}.${d}`),
      fc.constant(paise === "" ? `${text}.5` : text.slice(0, -1)),
      // L / Cr suffix.
      fc.constantFrom("L", "Cr").map((suffix) => `${text}${suffix}`),
      // Spaces and other whitespace.
      arbWhitespace.chain((ws) =>
        fc.constantFrom(
          `₹${ws}${rupees}${paise}`,
          `${ws}${text}`,
          `${text}${ws}`,
          `₹${rupees}${ws}.${frac}`,
          `₹${rupees}.${ws}${frac}`,
          `₹${rupees.replace(",", ws)}${paise}`,
        ),
      ),
      // Arbitrary unicode appended, prepended or inserted.
      arbGarbage.map((g) => `${text}${g}`),
      arbGarbage.map((g) => `${g}${text}`),
      fc.tuple(arbGarbage, fc.nat({ max: text.length })).map(([g, at]) => `${text.slice(0, at)}${g}${text.slice(at)}`),
    );
  })
  // A mutation that happens to give valid canonical text (e.g. western grouping of rupees < 1,000) is discarded.
  .filter(isNonCanonical);

/** Canonical-looking text (correct Indian grouping, valid paise) whose value exceeds MAX_SAFE_INTEGER paise. */
const arbOutOfRangeCanonicalLooking: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 1, arbitrary: fc.constantFrom(MAX_SAFE_PAISE_BIGINT + 1n, MAX_SAFE_PAISE_BIGINT + 2n, MAX_SAFE_PAISE_BIGINT + 100n) },
    { weight: 2, arbitrary: fc.bigInt({ min: MAX_SAFE_PAISE_BIGINT + 1n, max: MAX_SAFE_PAISE_BIGINT + 1_000_000n }) },
    { weight: 2, arbitrary: fc.bigInt({ min: MAX_SAFE_PAISE_BIGINT + 1n, max: 10n ** 24n }) },
  )
  .map((total) => {
    const rupees = total / 100n;
    const paise = total % 100n;
    const base = `₹${groupRupeesIndependently(rupees)}`;
    return paise === 0n ? base : `${base}.${String(paise).padStart(2, "0")}`;
  });

/** Runs parseINR on `text`, requires a ValidationError, and requires its message to contain `text`. */
function expectParseRejects(text: string): void {
  expect(() => parseINR(text)).toThrow(ValidationError);
  let caught: unknown;
  try {
    parseINR(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect((caught as ValidationError).message).toContain(text);
}

describe("format-inr properties: bad input", () => {
  // Feature: legal-engine, Property 20: Formatter and parser reject bad input
  it("Property 20: formatINR throws ValidationError for anything but a non-negative safe integer", () => {
    // **Validates: Requirements 7.5, 7.7**
    fc.assert(
      fc.property(arbBadPaise, fc.constantFrom<"full" | "short">("full", "short"), (value, style) => {
        expect(() => formatINR(value, style)).toThrow(ValidationError);
      }),
    );
  });

  // Feature: legal-engine, Property 20: Formatter and parser reject bad input
  it("Property 20: formatINR throws ValidationError for any style other than full or short", () => {
    // **Validates: Requirements 7.5, 7.7**
    const badStyle: fc.Arbitrary<unknown> = fc.oneof(
      fc.string().filter((s) => s !== "full" && s !== "short"),
      fc.constantFrom("Full", "SHORT", "full ", " short", "", "Full_Format", "long"),
      fc.constantFrom(undefined, null, 0, 1, true, false, {}, ["full"]),
    );
    fc.assert(
      fc.property(arbPaise, badStyle, (paise, style) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => formatINR(paise, style as any)).toThrow(ValidationError);
      }),
    );
    // The two cases from the review, spelled out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => formatINR(41_200_000, "Full" as any)).toThrow(ValidationError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => formatINR(41_200_000, undefined as any)).toThrow(ValidationError);
  });

  // Feature: legal-engine, Property 20: Formatter and parser reject bad input
  it("Property 20: parseINR throws ValidationError, naming the input, for mutated valid output", () => {
    // **Validates: Requirements 7.5, 7.7**
    fc.assert(
      fc.property(arbMutatedFullText, (text) => {
        expect(isNonCanonical(text)).toBe(true);
        expectParseRejects(text);
      }),
    );
  });

  // Feature: legal-engine, Property 20: Formatter and parser reject bad input
  it("Property 20: parseINR rejects arbitrary non-canonical strings", () => {
    // **Validates: Requirements 7.5, 7.7**
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.string({ unit: "grapheme" })).filter(isNonCanonical),
        (text) => {
          expectParseRejects(text);
        },
      ),
    );
  });

  // Feature: legal-engine, Property 20: Formatter and parser reject bad input
  it("Property 20: parseINR rejects canonical-looking text above MAX_SAFE_INTEGER paise", () => {
    // **Validates: Requirements 7.5, 7.7**
    fc.assert(
      fc.property(arbOutOfRangeCanonicalLooking, (text) => {
        // Shape is canonical, so only the range check can reject it.
        expect(CANONICAL_FULL.test(text)).toBe(true);
        expectParseRejects(text);
      }),
    );
  });
});
