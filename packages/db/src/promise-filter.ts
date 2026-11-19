import type { CalendarDate } from "@dues-banshee/engine";
import { sql, type SQL } from "drizzle-orm";
import { promises } from "./schema";

/**
 * The Engine_History promise filter: a `promises` row counts on `today` only if it was recorded on or
 * before `today` and had not been replaced by `today` (`superseded_on` is null or after `today`).
 * `today` is the Calendar_Date the caller resolved (an injected value, never the database clock).
 */
export function countedPromise(today: CalendarDate): SQL<boolean> {
  return sql<boolean>`(${promises.recordedOn} <= ${today} and (${promises.supersededOn} is null or ${promises.supersededOn} > ${today}))`;
}
