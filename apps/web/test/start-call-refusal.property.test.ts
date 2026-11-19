// Property test for `startCallRefusal` (buyer-voice-call, Property 4).
import { inCallWindow } from "@dues-banshee/voice";
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

// Feature: guardrails-evals, Call_Hours_Cases (Requirement 5)
interface CallHoursCase {
  name: string;
  /** Expected IST weekday and wall-clock time of `utcIso`, so a wrong date in the table fails loudly. */
  ist: { weekday: string; time: string };
  utcIso: string;
  isDemo: boolean;
  demoCallsToday: number;
  expected: StartCallRefusalKind | null;
}

const CALL_HOURS_CASES: CallHoursCase[] = [
  { name: "Mon 09:59", ist: { weekday: "Mon", time: "09:59" }, utcIso: "2026-11-16T04:29:00Z", isDemo: false, demoCallsToday: 0, expected: "outside_window" },
  { name: "Mon 10:00", ist: { weekday: "Mon", time: "10:00" }, utcIso: "2026-11-16T04:30:00Z", isDemo: false, demoCallsToday: 0, expected: null },
  { name: "Sat 18:59", ist: { weekday: "Sat", time: "18:59" }, utcIso: "2026-11-21T13:29:00Z", isDemo: false, demoCallsToday: 0, expected: null },
  { name: "Sat 19:00", ist: { weekday: "Sat", time: "19:00" }, utcIso: "2026-11-21T13:30:00Z", isDemo: false, demoCallsToday: 0, expected: "outside_window" },
  { name: "Sun 12:00", ist: { weekday: "Sun", time: "12:00" }, utcIso: "2026-11-22T06:30:00Z", isDemo: false, demoCallsToday: 0, expected: "outside_window" },
  { name: "Demo Sun 22:00, below cap", ist: { weekday: "Sun", time: "22:00" }, utcIso: "2026-11-22T16:30:00Z", isDemo: true, demoCallsToday: 19, expected: null },
  { name: "Demo Sun 22:00, at cap", ist: { weekday: "Sun", time: "22:00" }, utcIso: "2026-11-22T16:30:00Z", isDemo: true, demoCallsToday: DEMO_CALL_LIMIT, expected: "demo_limit" },
];

function istParts(ms: number): { weekday: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: get("weekday"), time: `${get("hour")}:${get("minute")}` };
}

describe("Call_Hours_Cases: startCallRefusal with inCallWindow", () => {
  it.each(CALL_HOURS_CASES)("$name -> $expected", (c) => {
    const ms = Date.parse(c.utcIso);
    expect(istParts(ms)).toEqual(c.ist);
    const refusal = startCallRefusal({
      found: true,
      configured: true,
      callable: true,
      isDemo: c.isDemo,
      inWindow: inCallWindow(ms),
      buyerCallsToday: 0,
      demoCallsToday: c.demoCallsToday,
    });
    expect(refusal).toBe(c.expected);
  });
});
