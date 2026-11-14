import { BankRateNotFoundError, getBankRate } from "@dues-banshee/db";
import type { Db } from "@dues-banshee/db";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";

/** The Bank_Rate in force on `day`, or null when none is effective yet. */
export async function loadBankRate(db: Db, day: CalendarDate): Promise<BankRate | null> {
  try {
    return await getBankRate(db, day);
  } catch (err) {
    if (err instanceof BankRateNotFoundError) return null;
    throw err;
  }
}
