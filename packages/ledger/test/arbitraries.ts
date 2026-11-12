import { formatINR } from "@dues-banshee/engine";
import fc from "fast-check";

/** Edge values every amount property must visit. */
export const EDGE_PAISE: readonly number[] = [
  0,
  1,
  99,
  100,
  10_000_000,
  1_000_000_000,
  Number.MAX_SAFE_INTEGER,
];

/**
 * Paise from 0 to MAX_SAFE, biased to the edges, small values, multiples of 10^7 (lakh)
 * and 10^9 (crore), and the largest safe integer.
 */
export const arbPaise: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.constantFrom(...EDGE_PAISE), weight: 2 },
  { arbitrary: fc.integer({ min: 0, max: 10_000_000 }), weight: 3 },
  { arbitrary: fc.maxSafeNat(), weight: 3 },
  { arbitrary: fc.integer({ min: 0, max: 900_000_000 }).map((k) => k * 10_000_000), weight: 1 },
  { arbitrary: fc.integer({ min: 0, max: 9_000_000 }).map((k) => k * 1_000_000_000), weight: 1 },
);

const LAKH_UNITS = ["L", "lakh", "lakhs", "lac", "lacs"] as const;
const CRORE_UNITS = ["crore", "crores"] as const;
const PREFIXES = ["", "₹", "Rs", "Rs.", "INR"] as const;
const DR_SUFFIXES = ["", " Dr", " dr", " DR", " dR"] as const;
const STYLES = ["plain", "indian", "western", "lakh", "crore"] as const;

type Style = (typeof STYLES)[number];

/** Applies a per-character upper/lower mask. Characters without case are unchanged. */
function applyCase(text: string, mask: readonly boolean[]): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    out += mask[i % mask.length] === true ? ch.toUpperCase() : ch.toLowerCase();
  }
  return out;
}

/** Digits of `p` divided by 10^places, as an exact decimal with trailing zeros and point removed. */
function exactDecimal(p: number, places: number): string {
  const digits = BigInt(p).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

function twoDigits(n: bigint): string {
  return n.toString().padStart(2, "0");
}

/** Renders a rupee-denominated style. `zeroSuffix` adds `.00` when the paise part is zero. */
function renderRupees(p: number, style: "plain" | "indian" | "western", zeroSuffix: boolean): string {
  const big = BigInt(p);
  const rupees = big / 100n;
  const paise = big % 100n;
  const fraction = paise === 0n ? (zeroSuffix ? ".00" : "") : `.${twoDigits(paise)}`;
  if (style === "plain") {
    return `${rupees.toString()}${fraction}`;
  }
  if (style === "western") {
    return `${rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction}`;
  }
  // Indian: the Engine formatter is the oracle. Strip "₹" and its ".PP" (we add our own fraction).
  const full = formatINR(p, "full").replace("₹", "");
  const wholeText = full.split(".")[0] ?? "";
  return `${wholeText}${fraction}`;
}

/**
 * Renders `p` in one of the accepted amount styles (Requirement 3.8).
 * Rendering uses BigInt and string arithmetic only and shares no code with `src/amount.ts`.
 */
export function arbAmountText(p: number): fc.Arbitrary<string> {
  return fc
    .record({
      style: fc.constantFrom<Style>(...STYLES),
      zeroSuffix: fc.boolean(),
      prefix: fc.constantFrom(...PREFIXES),
      prefixMask: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
      prefixSpace: fc.constantFrom("", " ", "  "),
      lakhUnit: fc.constantFrom(...LAKH_UNITS),
      croreUnit: fc.constantFrom(...CRORE_UNITS),
      unitMask: fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
      unitSpace: fc.constantFrom("", " "),
      slash: fc.boolean(),
      slashSpace: fc.constantFrom("", " "),
      dr: fc.constantFrom(...DR_SUFFIXES),
    })
    .map((o) => {
      let body: string;
      let unit = "";
      if (o.style === "lakh") {
        body = exactDecimal(p, 7);
        unit = applyCase(o.lakhUnit, o.unitMask);
      } else if (o.style === "crore") {
        body = exactDecimal(p, 9);
        unit = applyCase(o.croreUnit, o.unitMask);
      } else {
        body = renderRupees(p, o.style, o.zeroSuffix);
      }
      const prefix = o.prefix === "" ? "" : `${applyCase(o.prefix, o.prefixMask)}${o.prefixSpace}`;
      const unitPart = unit === "" ? "" : `${o.unitSpace}${unit}`;
      // A space before "/-" is only needed when something precedes it; harmless otherwise.
      const slashPart = o.slash ? `${o.slashSpace}/-` : "";
      return `${prefix}${body}${unitPart}${slashPart}${o.dr}`;
    });
}
