import type { CalendarDate } from "./types";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "2027-03-10" -> "10 Mar 2027". Input must be a valid Calendar_Date; day has no leading zero. */
export function formatDisplayDate(d: CalendarDate): string {
  const month = MONTH_NAMES[parseInt(d.slice(5, 7), 10) - 1];
  return `${parseInt(d.slice(8, 10), 10)} ${month} ${d.slice(0, 4)}`;
}
