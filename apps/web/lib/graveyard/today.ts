import { fromEpochDay, isValidCalendarDate, type CalendarDate } from "@dues-banshee/engine";

/** Earliest and latest `?today=` override the demo accepts (inclusive). */
export const DEMO_MIN: CalendarDate = "2024-01-01";
export const DEMO_MAX: CalendarDate = "2027-12-31";

export interface ResolvedToday {
  today: CalendarDate;
  /** The accepted `?today=` value, or null when Today is the real IST date. */
  override: CalendarDate | null;
}

const IST_OFFSET_MS = 19_800_000; // +05:30
const DAY_MS = 86_400_000;
const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The IST calendar date at `nowMs` (epoch milliseconds). Pure: the caller supplies the clock. */
export function istDate(nowMs: number): CalendarDate {
  return fromEpochDay(Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS));
}

/**
 * Resolves the page's Today. An array takes its first element only. The value is accepted when it is a
 * strict YYYY-MM-DD real calendar date within DEMO_MIN..DEMO_MAX; otherwise Today is the IST date.
 */
export function resolveToday(nowMs: number, raw: string | string[] | undefined): ResolvedToday {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof value === "string" &&
    STRICT_DATE.test(value) &&
    isValidCalendarDate(value) &&
    value >= DEMO_MIN &&
    value <= DEMO_MAX
  ) {
    return { today: value, override: value };
  }
  return { today: istDate(nowMs), override: null };
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2027-03-10" -> "10 Mar 2027". Input must be a valid Calendar_Date; day has no leading zero. */
export function formatDisplayDate(d: CalendarDate): string {
  const month = MONTH_NAMES[Number(d.slice(5, 7)) - 1];
  return `${Number(d.slice(8, 10))} ${month} ${d.slice(0, 4)}`;
}

export const TIME_TRAVEL_PRESETS: readonly { readonly label: string; readonly today: CalendarDate | null }[] = [
  { label: "Today", today: null },
  { label: "10 Mar 2027 (tax-bomb week)", today: "2027-03-10" },
  { label: "1 Apr 2027 (after 31 March)", today: "2027-04-01" },
];
