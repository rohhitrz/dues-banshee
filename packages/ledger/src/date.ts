import { ValidationError, fromEpochDay, isValidCalendarDate } from "@dues-banshee/engine";
import type { CalendarDate } from "@dues-banshee/engine";

/** Excel serial for 2000-01-01 (Excel's 1900 date system). */
export const EXCEL_SERIAL_MIN = 36526;
/** Excel serial for 2099-12-31. */
export const EXCEL_SERIAL_MAX = 73050;

/** Days from Excel's day 0 (1899-12-30) to 1970-01-01; exact for every serial above 60. */
const EXCEL_SERIAL_EPOCH_OFFSET = 25569;

const SERIAL_PATTERN = /^\d+$/;
const ISO_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const NUMERIC_FULL_YEAR_PATTERN = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
const NUMERIC_SHORT_YEAR_PATTERN = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2})$/;
const MONTH_NAME_PATTERN = /^(\d{1,2})-([a-z]{3})-(\d{4}|\d{2})$/i;

/** Longest trimmed cell text the parser will look at. */
const MAX_DATE_LENGTH = 64;
const MONTH_ABBREVIATIONS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/**
 * Parses a date cell written in a common Indian style into a Calendar_Date.
 * Numeric slash, dash and dot dates are always day first. Returns a
 * ValidationError (field "date") instead of throwing.
 */
export function parseDateLenient(raw: string): CalendarDate | ValidationError {
  const quoted = JSON.stringify(raw);
  const fail = (reason: string): ValidationError =>
    new ValidationError("date", `${reason}: ${quoted}`, raw);

  const text = raw.trim();
  if (text === "") return fail("is empty");
  if (text.length > MAX_DATE_LENGTH) return fail("not a recognised date");

  const build = (year: string, month: number, day: number): CalendarDate | ValidationError => {
    const candidate = `${year.padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return isValidCalendarDate(candidate) ? candidate : fail("not a real calendar day");
  };

  if (SERIAL_PATTERN.test(text)) {
    const serial = Number(text);
    if (text.length !== 5 || serial < EXCEL_SERIAL_MIN || serial > EXCEL_SERIAL_MAX) {
      return fail(`Excel serial outside ${EXCEL_SERIAL_MIN}–${EXCEL_SERIAL_MAX} (2000–2099)`);
    }
    return fromEpochDay(serial - EXCEL_SERIAL_EPOCH_OFFSET);
  }

  const iso = ISO_PATTERN.exec(text);
  if (iso !== null) {
    return build(iso[1] ?? "", Number(iso[2]), Number(iso[3]));
  }

  const numeric = NUMERIC_FULL_YEAR_PATTERN.exec(text);
  if (numeric !== null) {
    return build(numeric[4] ?? "", Number(numeric[3]), Number(numeric[1]));
  }

  if (NUMERIC_SHORT_YEAR_PATTERN.test(text)) {
    return fail("two-digit year; write the year in full or use a month name (02-Sep-26)");
  }

  const named = MONTH_NAME_PATTERN.exec(text);
  if (named !== null) {
    const monthIndex = MONTH_ABBREVIATIONS.indexOf(
      (named[2] ?? "").toLowerCase() as (typeof MONTH_ABBREVIATIONS)[number],
    );
    if (monthIndex === -1) return fail("unknown month");
    const yearText = named[3] ?? "";
    const year = yearText.length === 2 ? `20${yearText}` : yearText;
    return build(year, monthIndex + 1, Number(named[1]));
  }

  return fail("not a recognised date");
}
