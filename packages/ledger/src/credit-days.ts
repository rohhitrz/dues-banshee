import { ValidationError } from "@dues-banshee/engine";

/**
 * Optional `Net` prefix, 1-6 digits, optional `day`/`days` suffix. Whitespace
 * is collapsed to single spaces before matching, and each optional space sits
 * inside the optional group it introduces.
 */
const CREDIT_DAYS_PATTERN = /^(?:net ?)?(\d{1,6})(?: ?days?)?$/i;

/** Longest trimmed cell text the parser will look at. */
const MAX_CREDIT_DAYS_LENGTH = 64;

/**
 * Parses a credit-days cell (`45`, `45 days`, `Net 30`, `1 day`).
 * Blank means no agreed term and gives `undefined`. `0` is returned as 0; the
 * Engine rejects it later. Returns a ValidationError (field "creditDays")
 * instead of throwing.
 */
export function parseCreditDays(raw: string): number | undefined | ValidationError {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const match =
    trimmed.length > MAX_CREDIT_DAYS_LENGTH
      ? null
      : CREDIT_DAYS_PATTERN.exec(trimmed.replace(/\s+/g, " "));
  if (match === null) {
    return new ValidationError(
      "creditDays",
      `not a number of days: ${JSON.stringify(raw)}`,
      raw,
    );
  }
  return Number(match[1]);
}
