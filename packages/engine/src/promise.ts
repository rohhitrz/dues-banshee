import type { CalendarDate, EscalationHistory } from "./types";

/**
 * Latest promisedDate among `promise` events with promisedDate >= today
 * (CalendarDate string compare); null iff no such event exists.
 * Pure: no clock, inputs not mutated.
 */
export function activePromiseUntil(history: EscalationHistory, today: CalendarDate): CalendarDate | null {
  let latest: CalendarDate | null = null;
  for (const event of history) {
    if (event.kind !== "promise" || event.promisedDate < today) continue;
    if (latest === null || event.promisedDate > latest) latest = event.promisedDate;
  }
  return latest;
}

/** True iff some `promise` event has promisedDate >= today. Defined through activePromiseUntil so they can't disagree. */
export function hasActivePromise(history: EscalationHistory, today: CalendarDate): boolean {
  return activePromiseUntil(history, today) !== null;
}
