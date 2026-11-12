import { isValidCalendarDate, type BankRate, type CalendarDate } from "@dues-banshee/engine";
import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "./client";
import { config } from "./schema";

/** `config.key` of the RBI bank rate, stored in basis points (MSMED-16). */
export const BANK_RATE_KEY = "rbi_bank_rate_bps";

/**
 * Returns the bank rate in force on `today`: the row with the latest `effective_from` on or before
 * `today`, with `asOf` set to that date. Throws if `today` isn't a valid Calendar_Date or no row
 * is effective by then.
 */
export async function getBankRate(db: Db, today: CalendarDate): Promise<BankRate> {
  if (!isValidCalendarDate(today)) {
    throw new Error(`getBankRate: today must be a valid YYYY-MM-DD date, got ${JSON.stringify(today)}`);
  }
  const [row] = await db
    .select({ valueInt: config.valueInt, effectiveFrom: config.effectiveFrom })
    .from(config)
    .where(and(eq(config.key, BANK_RATE_KEY), lte(config.effectiveFrom, today)))
    .orderBy(desc(config.effectiveFrom))
    .limit(1);
  if (!row) throw new Error(`config "${BANK_RATE_KEY}": no row effective on or before ${today}`);
  return { annualBps: row.valueInt, asOf: row.effectiveFrom };
}
