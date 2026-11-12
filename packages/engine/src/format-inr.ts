import type { InrStyle, Paise } from "./types";
import { assertOneOf } from "./validate";
import { ValidationError } from "./validation-error";

const INR_STYLES: readonly InrStyle[] = ["full", "short"];
const PAISE_PER_RUPEE = 100;
const PAISE_PER_LAKH = 1e7;
const PAISE_PER_CRORE = 1e9;

/** Groups a non-negative integer Indian-style: last three digits, then pairs from the right. */
function groupIndian(n: number): string {
  const digits = String(n);
  if (digits.length <= 3) {
    return digits;
  }
  const head = digits.slice(0, -3);
  const tail = digits.slice(-3);
  const pairs: string[] = [];
  for (let end = head.length; end > 0; end -= 2) {
    pairs.unshift(head.slice(Math.max(0, end - 2), end));
  }
  return `${pairs.join(",")},${tail}`;
}

/**
 * Divides `p` by `unit` and rounds half-up.
 * With `r = p % unit` and `q = (p - r) / unit`, the result is `q + 1` when `2 * r >= unit`, else `q`.
 * `p - r` is an exact multiple of `unit`, so the quotient is exact. This avoids forming `p + unit / 2`
 * (which could leave the safe range) and avoids a float quotient `p / unit` that can round up to the
 * next integer near Number.MAX_SAFE_INTEGER. `2 * r < 2 * unit <= 2e9`, so the comparison is exact.
 */
function roundedDiv(p: number, unit: number): number {
  const r = p % unit;
  const q = (p - r) / unit;
  return 2 * r >= unit ? q + 1 : q;
}

/** Renders `hundredths / 100` with trailing zeros and a trailing point removed; integer part grouped. */
function formatHundredths(hundredths: number): string {
  const frac = hundredths % 100;
  const whole = (hundredths - frac) / 100;
  const grouped = groupIndian(whole);
  if (frac === 0) {
    return grouped;
  }
  const fracText = String(frac).padStart(2, "0").replace(/0$/, "");
  return `${grouped}.${fracText}`;
}

function formatFull(p: Paise): string {
  const paisePart = p % PAISE_PER_RUPEE;
  const rupees = (p - paisePart) / PAISE_PER_RUPEE;
  const base = `₹${groupIndian(rupees)}`;
  return paisePart === 0 ? base : `${base}.${String(paisePart).padStart(2, "0")}`;
}

function formatShort(p: Paise): string {
  if (p >= PAISE_PER_CRORE) {
    // Hundredths of a crore, half-up.
    return `₹${formatHundredths(roundedDiv(p, PAISE_PER_CRORE / 100))}Cr`;
  }
  if (p >= PAISE_PER_LAKH) {
    // Hundredths of a lakh, half-up. 100 lakh rounds up to one crore.
    const hundredths = roundedDiv(p, PAISE_PER_LAKH / 100);
    if (hundredths >= 10000) {
      return "₹1Cr";
    }
    return `₹${formatHundredths(hundredths)}L`;
  }
  // Whole rupees, half-up. 1,00,000 rupees rounds up to one lakh.
  const rupees = roundedDiv(p, PAISE_PER_RUPEE);
  if (rupees >= 100000) {
    return "₹1L";
  }
  return `₹${groupIndian(rupees)}`;
}

/**
 * Formats an amount in paise as Indian rupee text.
 * `full`: ₹4,12,000 or ₹4,12,000.50. `short`: ₹4.12L or ₹1.25Cr.
 */
export function formatINR(paise: Paise, style: InrStyle): string {
  if (typeof paise !== "number" || !Number.isSafeInteger(paise) || paise < 0) {
    throw new ValidationError("paise", "must be a non-negative safe integer number of paise", paise);
  }
  assertOneOf("style", style, INR_STYLES);
  return style === "full" ? formatFull(paise) : formatShort(paise);
}

/** Exactly the shape of `formatINR(·, "full")`: Indian grouping, no leading zeros, optional two-digit paise. */
const FULL_FORMAT = /^₹(0|[1-9]\d{0,2}|[1-9]\d?(?:,\d{2})*,\d{3})(?:\.(\d{2}))?$/;
const MAX_SAFE_PAISE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parses canonical Full_Format text (the output set of `formatINR(·, "full")`) into paise.
 * Rejects everything else, including `.00`, western grouping, suffixes and spaces.
 */
export function parseINR(text: string): Paise {
  if (typeof text !== "string") {
    throw new ValidationError("text", "must be a string", text);
  }
  const fail = (): never => {
    throw new ValidationError("text", `not in Full_Format: "${text}"`, text);
  };
  const match = FULL_FORMAT.exec(text);
  if (match === null) {
    return fail();
  }
  const rupeesText = (match[1] ?? "").replace(/,/g, "");
  const paiseText = match[2];
  if (paiseText === "00") {
    return fail();
  }
  // BigInt keeps the range check exact: rupees * 100 can exceed 2^53 before the check.
  const total = BigInt(rupeesText) * 100n + BigInt(paiseText ?? "0");
  if (total > MAX_SAFE_PAISE) {
    return fail();
  }
  return Number(total);
}
