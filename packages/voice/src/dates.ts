import {
  addDays,
  financialYearEnd,
  formatDisplayDate,
  isoWeekday,
  isValidCalendarDate,
  istCalendarDate,
} from "@dues-banshee/engine";
import type { CalendarDate } from "@dues-banshee/engine";

const PROMISE_WINDOW_DAYS = 30;
const IST_OFFSET_MS = 19_800_000; // Asia/Kolkata, UTC+05:30, no DST
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Call window: 10:00 (inclusive) to 19:00 (exclusive) IST, Monday to Saturday. */
const CALL_OPEN_MINUTE = 10 * 60;
const CALL_CLOSE_MINUTE = 19 * 60;
const LAST_CALL_WEEKDAY = 6; // Saturday; Sunday is 7

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Both inputs are zero-padded YYYY-MM-DD, so string order is date order. */
function earlier(a: CalendarDate, b: CalendarDate): CalendarDate {
  return a <= b ? a : b;
}

/**
 * Dates a buyer may promise to pay on: `callToday` to the earlier of `callToday + 30 days`
 * and 31 March closing the financial year of `callToday`. Both ends inclusive.
 */
export function promiseWindow(callToday: CalendarDate): { first: CalendarDate; last: CalendarDate } {
  return {
    first: callToday,
    last: earlier(addDays(callToday, PROMISE_WINDOW_DAYS), financialYearEnd(callToday)),
  };
}

/** True when `date` is a real calendar day inside `promiseWindow(callToday)`. */
export function inPromiseWindow(date: string, callToday: CalendarDate): boolean {
  if (!isValidCalendarDate(date)) return false;
  const { first, last } = promiseWindow(callToday);
  return date >= first && date <= last;
}

/** "2026-11-12" -> "Thursday, 12 Nov 2026": English weekday, then D MMM YYYY. */
export function agentDate(d: CalendarDate): string {
  return `${WEEKDAY_NAMES[isoWeekday(d) - 1]}, ${formatDisplayDate(d)}`;
}

/** `agentDate` for every date in `promiseWindow(callToday)`, ascending. */
export function buildDateList(callToday: CalendarDate): string[] {
  const { first, last } = promiseWindow(callToday);
  const list: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) list.push(agentDate(d));
  return list;
}

/** True when the instant `nowMs` (epoch ms) is 10:00 <= t < 19:00 IST on Monday to Saturday. */
export function inCallWindow(nowMs: number): boolean {
  const minuteOfDay = Math.floor((((nowMs + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS / MINUTE_MS);
  if (minuteOfDay < CALL_OPEN_MINUTE || minuteOfDay >= CALL_CLOSE_MINUTE) return false;
  return isoWeekday(istCalendarDate(nowMs)) <= LAST_CALL_WEEKDAY;
}

/**
 * The instants bounding one Asia/Kolkata calendar day, as a half-open range:
 * `start` is 00:00 IST on `day`, `end` is 00:00 IST on the next day (exclusive).
 */
export function istDayBounds(day: CalendarDate): { start: Date; end: Date } {
  const startMs =
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) - IST_OFFSET_MS;
  return { start: new Date(startMs), end: new Date(startMs + DAY_MS) };
}
