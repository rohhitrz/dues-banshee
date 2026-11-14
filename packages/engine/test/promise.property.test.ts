import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays } from "../src/calendar-date";
import { activePromiseUntil, hasActivePromise } from "../src/index";
import type { CalendarDate, EscalationHistory } from "../src/types";
import { arbHistory, arbInvoice, arbToday } from "./arbitraries";

// ---------------------------------------------------------------------------
// Shared generators for Property 1 (hasActivePromise) and Property 2 (activePromiseUntil).
// ---------------------------------------------------------------------------

/**
 * A history (empty, steps only, or several promises mixed with steps, from `arbHistory`)
 * and a `today`. `today` comes from `arbToday`, or sits on, one day before or one day after
 * a promised date in the history, so the `>=` boundary is hit often.
 */
const arbHistoryAndToday: fc.Arbitrary<{ history: EscalationHistory; today: CalendarDate }> = arbInvoice.chain((inv) =>
  arbHistory(inv).chain((history) => {
    const promised = history.flatMap((e) => (e.kind === "promise" ? [e.promisedDate] : []));
    const today =
      promised.length === 0
        ? arbToday(inv)
        : fc.oneof(
            { weight: 1, arbitrary: arbToday(inv) },
            {
              weight: 1,
              arbitrary: fc
                .tuple(fc.constantFrom(...promised), fc.constantFrom(-1, 0, 1))
                .map(([date, offset]) => addDays(date, offset)),
            },
          );
    return today.map((t) => ({ history, today: t }));
  }),
);

describe("hasActivePromise", () => {
  // Feature: debtor-ui, Property 1: hasActivePromise matches the wisp rule
  it("equals the wisp rule: some promise event with promisedDate >= today", () => {
    fc.assert(
      fc.property(arbHistoryAndToday, ({ history, today }) => {
        const reference = history.some((e) => e.kind === "promise" && e.promisedDate >= today);
        expect(hasActivePromise(history, today)).toBe(reference);
      }),
      { numRuns: 200 },
    );
  });
});

describe("activePromiseUntil", () => {
  // Feature: debtor-ui, Property 2: activePromiseUntil agrees with hasActivePromise and is the latest active date
  it("is non-null iff hasActivePromise, and equals the latest promisedDate >= today", () => {
    fc.assert(
      fc.property(arbHistoryAndToday, ({ history, today }) => {
        const active = history.flatMap((e) => (e.kind === "promise" && e.promisedDate >= today ? [e.promisedDate] : []));
        const reference = active.length === 0 ? null : active.reduce((max, d) => (d > max ? d : max));
        const until = activePromiseUntil(history, today);
        expect(until !== null).toBe(hasActivePromise(history, today));
        expect(until).toEqual(reference);
      }),
      { numRuns: 200 },
    );
  });
});
