// Feature: buyer-voice-call, Property 5: Promise amount check
// **Validates: Requirements 5.9, 5.10**
import { MAX_PAISE } from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkPromiseAmount } from "../src/invoice-facts";

const amount = fc.integer({ min: -1_000_000_000, max: 1_000_000_000_000 });
const anyTotal = fc.integer({ min: 1, max: MAX_PAISE });

// Totals close to the amount, so the boundaries amount = total - 1, total, total + 1 are hit often.
const scenario = fc.oneof(
  fc.tuple(amount, anyTotal),
  fc.tuple(amount, fc.integer({ min: -2, max: 2 })).map(([a, delta]): [number, number] => [
    a,
    Math.min(MAX_PAISE, Math.max(1, a + delta)),
  ]),
  fc.tuple(fc.constantFrom(-1, 0, 1, 2), fc.constantFrom(1, 2, MAX_PAISE)),
);

describe("Property 5: Promise amount check", () => {
  it("is ok iff 1 <= amount <= total, partial iff amount < total", () => {
    fc.assert(
      fc.property(scenario, ([a, total]) => {
        const result = checkPromiseAmount(a, total);
        if (a >= 1 && a <= total) {
          expect(result).toEqual({ ok: true, isPartial: a < total });
        } else {
          expect(result).toEqual({ ok: false });
        }
      }),
      { numRuns: 500 },
    );
  });
});
