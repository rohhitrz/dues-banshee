import { ValidationError } from "@dues-banshee/engine";
import type { Paise } from "@dues-banshee/engine";

/**
 * prefix, number (plain | Indian | western), fraction, unit (longest first),
 * "rupees only" mark, Balance_Suffix. `Cr` can't be read as a unit because the
 * unit alternatives contain only `crore`/`crores`, so a trailing `Cr` reaches
 * the suffix group.
 */
const AMOUNT_PATTERN =
  /^(?:(₹|rs\.?|inr)\s*)?(\d+|\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?\s*(lakhs|lakh|lacs|lac|l|crores|crore)?\s*(\/-)?\s*(dr|cr)?$/i;

const PAISE_PER_RUPEE = 100n;
const PAISE_PER_LAKH = 10_000_000n;
const PAISE_PER_CRORE = 1_000_000_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function multiplierFor(unit: string | undefined): bigint {
  if (unit === undefined || unit === "") return PAISE_PER_RUPEE;
  return unit.toLowerCase().startsWith("c") ? PAISE_PER_CRORE : PAISE_PER_LAKH;
}

/**
 * Parses an amount cell written in any common Indian style into paise.
 * Returns a ValidationError (field "amount") instead of throwing.
 */
export function parseAmountLenient(raw: string): Paise | ValidationError {
  const fail = (reason: string): ValidationError =>
    new ValidationError("amount", `${reason}: ${JSON.stringify(raw)}`, raw);

  const text = raw.trim();
  if (text === "") return fail("is empty");

  const match = AMOUNT_PATTERN.exec(text);
  if (match === null) return fail("not a recognised amount");

  const whole = match[2] ?? "";
  const frac = match[3] ?? "";
  const suffix = match[6];

  if (suffix !== undefined && suffix.toLowerCase() === "cr") {
    return fail("Credit balance (Cr) is not a receivable");
  }

  const scaled = BigInt(whole.replace(/,/g, "") + frac) * multiplierFor(match[4]);
  const den = 10n ** BigInt(frac.length);
  if (scaled % den !== 0n) return fail("more precise than one paisa");

  const paise = scaled / den;
  if (paise > MAX_SAFE) {
    return fail("above the largest supported amount (9007199254740991 paise)");
  }
  return Number(paise);
}
