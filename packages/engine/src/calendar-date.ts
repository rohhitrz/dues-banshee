import type { CalendarDate } from "./types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 9999;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/** Splits an already-validated "YYYY-MM-DD" string into numbers. */
function parseParts(d: CalendarDate): [number, number, number] {
  return [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))];
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** True when `value` is a real calendar day written as YYYY-MM-DD, years 1900..9999. */
export function isValidCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = parseParts(value);
  if (year < MIN_YEAR || year > MAX_YEAR) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/** Days since 1970-01-01 (Hinnant days_from_civil). Input must be valid. */
export function toEpochDay(d: CalendarDate): number {
  const [y0, m, day] = parseParts(d);
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = (m + 9) % 12; // March = 0
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of `toEpochDay` (Hinnant civil_from_days), as zero-padded YYYY-MM-DD. */
export function fromEpochDay(epochDay: number): CalendarDate {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  ); // [0, 399]
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

const IST_OFFSET_MS = 19_800_000; // Asia/Kolkata, UTC+05:30, no DST
const DAY_MS = 86_400_000;

/** The IST calendar date at `nowMs` (epoch milliseconds). Pure: the caller supplies the clock. */
export function istCalendarDate(nowMs: number): CalendarDate {
  return fromEpochDay(Math.floor((nowMs + IST_OFFSET_MS) / DAY_MS));
}

export function addDays(d: CalendarDate, n: number): CalendarDate {
  return fromEpochDay(toEpochDay(d) + n);
}

/** Whole days from `a` to `b` (b - a). */
export function dayDifference(a: CalendarDate, b: CalendarDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function compareDates(a: CalendarDate, b: CalendarDate): -1 | 0 | 1 {
  const diff = toEpochDay(a) - toEpochDay(b);
  if (diff < 0) return -1;
  if (diff > 0) return 1;
  return 0;
}

/** 31 March that closes the financial year containing `d` (FY runs 1 Apr to 31 Mar). */
export function financialYearEnd(d: CalendarDate): CalendarDate {
  const [year, month] = parseParts(d);
  return month >= 4 ? `${pad(year + 1, 4)}-03-31` : `${pad(year, 4)}-03-31`;
}
