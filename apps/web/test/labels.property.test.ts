// Feature: dashboard-ui, Property 7: Label maps are exhaustive and exact
// **Validates: Requirements 5.7, 5.8, 5.9**
import {
  LADDER_STEPS,
  stepRank,
  type CoveredWaitReason,
  type EscalationDecision,
  type LadderStep,
  type NonCoverageReason,
  type WaitReason,
} from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STEP_TEXT, WAIT_TEXT, nextStepLabel } from "../lib/graveyard/labels";

// The Engine exports no list of wait reasons. A member missing from either record fails typecheck.
const COVERED_WAIT_REASONS: Record<CoveredWaitReason, true> = {
  paid: true,
  not_overdue: true,
  promise_active: true,
  ladder_complete: true,
  cooldown: true,
};
const NON_COVERAGE_REASONS: Record<NonCoverageReason, true> = {
  medium_or_unregistered: true,
  trader: true,
};
const ALL_WAIT_REASONS: Record<WaitReason, true> = {
  ...COVERED_WAIT_REASONS,
  ...NON_COVERAGE_REASONS,
};

const coveredReasons = Object.keys(COVERED_WAIT_REASONS) as CoveredWaitReason[];
const nonCoverageReasons = Object.keys(NON_COVERAGE_REASONS) as NonCoverageReason[];
const allReasons = Object.keys(ALL_WAIT_REASONS) as WaitReason[];

function advance(step: LadderStep): EscalationDecision {
  return {
    action: "advance",
    applicable: true,
    step,
    rank: stepRank(step),
    requiresApproval: false,
    ruleIds: [],
  };
}

function wait(reason: WaitReason): EscalationDecision {
  if (reason === "medium_or_unregistered" || reason === "trader") {
    return { action: "wait", applicable: false, reason, ruleIds: ["MSMED-SCOPE"] };
  }
  return { action: "wait", applicable: true, reason, ruleIds: [] };
}

const NUM_RUNS = 100;

describe("Property 7: Label maps are exhaustive and exact", () => {
  it("covers every wait reason the Engine can return", () => {
    expect(allReasons).toHaveLength(coveredReasons.length + nonCoverageReasons.length);
    expect(new Set(allReasons).size).toBe(7);
  });

  it("advance label is 'Next: ' + STEP_TEXT[step] for every LADDER_STEP", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LADDER_STEPS), (step) => {
        expect(nextStepLabel(advance(step))).toBe("Next: " + STEP_TEXT[step]);
        expect(STEP_TEXT[step].length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("wait label is 'Waiting: ' + WAIT_TEXT[reason] for every WaitReason", () => {
    fc.assert(
      fc.property(fc.constantFrom(...allReasons), (reason) => {
        expect(nextStepLabel(wait(reason))).toBe("Waiting: " + WAIT_TEXT[reason]);
        expect(WAIT_TEXT[reason].length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("STEP_TEXT and WAIT_TEXT have exactly the Engine's keys", () => {
    expect(Object.keys(STEP_TEXT).sort()).toEqual([...LADDER_STEPS].sort());
    expect(Object.keys(WAIT_TEXT).sort()).toEqual([...allReasons].sort());
  });
});
