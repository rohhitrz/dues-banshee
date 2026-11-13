import type {
  CoveredWaitReason,
  EscalationDecision,
  LadderStep,
  NonCoverageReason,
} from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { nextStepLabel, stateText, type TombstoneState } from "@/lib/graveyard/labels";

const advance = (step: LadderStep): EscalationDecision => ({
  action: "advance",
  applicable: true,
  step,
  rank: 1,
  requiresApproval: false,
  ruleIds: [],
});

const coveredWait = (reason: CoveredWaitReason): EscalationDecision => ({
  action: "wait",
  applicable: true,
  reason,
  ruleIds: [],
});

const nonCovered = (reason: NonCoverageReason): EscalationDecision => ({
  action: "wait",
  applicable: false,
  reason,
  ruleIds: ["MSMED-SCOPE"],
});

describe("nextStepLabel", () => {
  it.each<[LadderStep, string]>([
    ["whatsapp_nudge", "Next: WhatsApp nudge"],
    ["whatsapp_paylink", "Next: WhatsApp + UPI link"],
    ["voice_call", "Next: Voice call"],
    ["legal_notice", "Next: Legal notice"],
    ["odr_pack", "Next: MSME ODR pack"],
  ])("advance to %s reads %j", (step, expected) => {
    expect(nextStepLabel(advance(step))).toBe(expected);
  });

  it.each<[CoveredWaitReason, string]>([
    ["paid", "Waiting: Paid"],
    ["not_overdue", "Waiting: Not due yet"],
    ["promise_active", "Waiting: Promise to pay active"],
    ["cooldown", "Waiting: Gap since last step"],
    ["ladder_complete", "Waiting: All steps done"],
  ])("wait for %s reads %j", (reason, expected) => {
    expect(nextStepLabel(coveredWait(reason))).toBe(expected);
  });

  it.each<[NonCoverageReason, string]>([
    ["medium_or_unregistered", "Waiting: Not a Udyam micro/small supplier"],
    ["trader", "Waiting: Trader, outside MSMED"],
  ])("non-coverage %s reads %j", (reason, expected) => {
    expect(nextStepLabel(nonCovered(reason))).toBe(expected);
  });
});

describe("stateText", () => {
  const base = { daysLeft: 0, nonCoverageReason: null } as const;

  it.each<[TombstoneState, string]>([
    ["not_due", "Not due yet"],
    ["overdue", "Overdue, interest accruing"],
    ["exploded", "Tax bomb exploded"],
    ["resurrected", "Resurrected (paid)"],
    ["not_covered", "Outside MSMED"],
  ])("%s without extra input reads %j", (state, expected) => {
    expect(stateText({ ...base, state })).toBe(expected);
  });

  it("armed shows the days left to 31 March", () => {
    expect(stateText({ state: "armed", daysLeft: 139, nonCoverageReason: null })).toBe(
      "Tax bomb armed: 139 days left to 31 March",
    );
  });

  it.each<[NonCoverageReason, string]>([
    ["medium_or_unregistered", "Outside MSMED (Not a Udyam micro/small supplier)"],
    ["trader", "Outside MSMED (Trader, outside MSMED)"],
  ])("not_covered with reason %s reads %j", (reason, expected) => {
    expect(stateText({ state: "not_covered", daysLeft: 0, nonCoverageReason: reason })).toBe(
      expected,
    );
  });
});
