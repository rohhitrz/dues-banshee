import { isValidCalendarDate, istCalendarDate, type CalendarDate } from "@dues-banshee/engine";

/** Earliest and latest `?today=` override the demo accepts (inclusive). */
export const DEMO_MIN: CalendarDate = "2024-01-01";
export const DEMO_MAX: CalendarDate = "2027-12-31";

export interface ResolvedToday {
  today: CalendarDate;
  /** The accepted `?today=` value, or null when Today is the real IST date. */
  override: CalendarDate | null;
}

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Moved into the Engine (whatsapp-channel task 1.1) as `istCalendarDate`; re-exported so callers stay unchanged. */
export { istCalendarDate as istDate } from "@dues-banshee/engine";

/**
 * True when `value` is a usable `?today=` override: a strict YYYY-MM-DD real calendar date within
 * DEMO_MIN..DEMO_MAX. Pure, so client components can use it too.
 */
export function isValidTodayOverride(value: unknown): value is CalendarDate {
  return (
    typeof value === "string" &&
    STRICT_DATE.test(value) &&
    isValidCalendarDate(value) &&
    value >= DEMO_MIN &&
    value <= DEMO_MAX
  );
}
/**
 * Resolves the page's Today. An array takes its first element only. The value is accepted when
 * `isValidTodayOverride` holds; otherwise Today is the IST date.
 */
export function resolveToday(nowMs: number, raw: string | string[] | undefined): ResolvedToday {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (isValidTodayOverride(value)) return { today: value, override: value };
  return { today: istCalendarDate(nowMs), override: null };
}
/** Moved into the Engine (escalation-ladder task 2.1); re-exported so dashboard-ui callers stay unchanged. */
export { formatDisplayDate } from "@dues-banshee/engine";

export const TIME_TRAVEL_PRESETS: readonly { readonly label: string; readonly today: CalendarDate | null }[] = [
  { label: "Today", today: null },
  { label: "10 Mar 2027 (tax-bomb week)", today: "2027-03-10" },
  { label: "1 Apr 2027 (after 31 March)", today: "2027-04-01" },
];
