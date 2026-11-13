import type { CalendarDate } from "@dues-banshee/engine";
import { formatDisplayDate } from "@/lib/graveyard/today";

/** Shown wherever an interest figure or the "Rules as of" line would be when no Bank_Rate applies (Req 2.5, 3.9). */
export function bankRateMissingText(today: CalendarDate): string {
  return `Bank rate not configured for ${formatDisplayDate(today)}`;
}
