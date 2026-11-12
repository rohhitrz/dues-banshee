import { ValidationError } from "@dues-banshee/engine";

/** Optional `Net` prefix, 1-6 digits, optional `day`/`days` suffix. */
const CREDIT_DAYS_PATTERN = /^(?:net\s*)?(\d{1,6})(?:\s*days?)?$/i;

/**
 * Parses a credit-days cell (`45`, `45 days`, `Net 30`, `1 day`).
 * Blank means no agreed term and gives `undefined`. `0` is returned as 0; the
 * Engine rejects it later. Returns a ValidationError (field "creditDays")
 * instead of throwing.
 */
export function parseCreditDays(raw: string): number | undefined | ValidationError {
  const text = raw.trim();
  if (text === "") return undefined;

  const match = CREDIT_DAYS_PATTERN.exec(text);
  if (match === null) {
    return new ValidationError(
      "creditDays",
      `not a number of days: ${JSON.stringify(raw)}`,
      raw,
    );
  }
  return Number(match[1]);
}
