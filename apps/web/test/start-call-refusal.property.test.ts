// Property test for `startCallRefusal` (buyer-voice-call, Property 4).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEMO_CALL_LIMIT,
  REFUSAL_TEXT,
  startCallRefusal,
  type StartCallRefusalInput,
  type StartCallRefusalKind,
} from "../lib/call/callable";

const NUM_RUNS = 200;

const inputArb: fc.Arbitrary<StartCallRefusalInput> = fc.record({
  found: fc.boolean(),
  configured: fc.boolean(),
  callable: fc.boolean(),
  isDemo: fc.boolean(),
  inWindow: fc.boolean(),
  buyerCallsToday: fc.integer({ min: 0, max: 3 }),
  demoCallsToday: fc.integer({ min: 0, max: 25 }),
});

/**
 * Independent oracle: the Req 1 C13 order written as a list of (refusal, holds) pairs, first holding one wins.
 * The demo-only and non-demo-only refusals carry their own supplier guard, so the list needs no branching.
 */
function oracle(i: StartCallRefusalInput): StartCallRefusalKind | null {
  const ordered: Array<[StartCallRefusalKind, boolean]> = [
    ["not_found", !i.found],
    ["not_configured", !i.configured],
    ["not_callable", !i.callable],
    ["outside_window", !i.isDemo && !i.inWindow],
    ["already_called", !i.isDemo && i.buyerCallsToday >= 1],
    ["demo_limit", i.isDemo && i.demoCallsToday >= 20],
  ];
  const first = ordered.find(([, holds]) => holds);
  return first ? first[0] : null;
}

describe("Property 4: Start-call refusal order", () => {
  // Feature: buyer-voice-call, Property 4: Start-call refusal order
  // **Validates: Requirements 1.5, 1.6, 1.12, 1.13, 1.14, 1.15**
  it("returns the first holding Req 1 C13 refusal, or null when none holds", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(startCallRefusal(input)).toBe(oracle(input));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: buyer-voice-call, Property 4: Start-call refusal order
  // **Validates: Requirements 1.5, 1.6, 1.14, 1.15**
  it("never returns outside_window or already_called for the demo supplier", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = startCallRefusal({ ...input, isDemo: true });
        expect(result).not.toBe("outside_window");
        expect(result).not.toBe("already_called");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: buyer-voice-call, Property 4: Start-call refusal order
  // **Validates: Requirements 1.14**
  it("never returns demo_limit for a non-demo supplier", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(startCallRefusal({ ...input, isDemo: false })).not.toBe("demo_limit");
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("uses 20 as the demo limit and has a message for every refusal", () => {
    expect(DEMO_CALL_LIMIT).toBe(20);
    const base: StartCallRefusalInput = {
      found: true,
      configured: true,
      callable: true,
      isDemo: true,
      inWindow: false,
      buyerCallsToday: 3,
      demoCallsToday: 19,
    };
    expect(startCallRefusal(base)).toBeNull();
    expect(startCallRefusal({ ...base, demoCallsToday: 20 })).toBe("demo_limit");
    expect(REFUSAL_TEXT.demo_limit).toBe("Demo call limit reached for today");
  });
});
