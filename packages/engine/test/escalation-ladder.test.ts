import { describe, expect, it } from "vitest";
import { APPROVAL_STEP_LIST, LADDER_STEPS, isApprovalStep, nextEscalationStep } from "../src/index";
import type { EscalationHistory, Invoice, LadderStep } from "../src/types";
import { sharmaTradersInvoice } from "./fixtures";

// Sharma Traders: due date 2026-10-17, default Step_Gap_Days 7.

function invoiceWith(overrides: Partial<Invoice>): Invoice {
  return { ...sharmaTradersInvoice, ...overrides };
}

function stepEvent(step: LadderStep, on: string) {
  return { kind: "step", step, on } as const;
}

function promiseEvent(promisedDate: string, recordedOn: string) {
  return { kind: "promise", promisedDate, amountPaise: 41_200_000, recordedOn } as const;
}

describe("nextEscalationStep", () => {
  describe("first step and not overdue", () => {
    it("advances to a WhatsApp nudge the day after the due date, without approval", () => {
      expect(nextEscalationStep(sharmaTradersInvoice, [], "2026-10-18")).toStrictEqual({
        action: "advance",
        applicable: true,
        step: "whatsapp_nudge",
        rank: 1,
        requiresApproval: false,
        ruleIds: ["MSMED-15"],
      });
    });

    it("waits with not_overdue on the due date itself", () => {
      expect(nextEscalationStep(sharmaTradersInvoice, [], "2026-10-17")).toStrictEqual({
        action: "wait",
        applicable: true,
        reason: "not_overdue",
        ruleIds: [],
      });
    });
  });

  describe("advancing and approval", () => {
    it("advances to the ODR pack after a legal notice 7 days ago, citing MSMED-18 and MSMED-ODR", () => {
      const history: EscalationHistory = [
        stepEvent("whatsapp_nudge", "2026-10-18"),
        stepEvent("whatsapp_paylink", "2026-10-20"),
        stepEvent("voice_call", "2026-10-22"),
        stepEvent("legal_notice", "2026-10-25"),
      ];
      const decision = nextEscalationStep(sharmaTradersInvoice, history, "2026-11-01");
      expect(decision).toMatchObject({
        action: "advance",
        step: "odr_pack",
        rank: 5,
        requiresApproval: true,
      });
      expect(decision.ruleIds).toEqual(["MSMED-15", "MSMED-18", "MSMED-ODR"]);
    });

    it("sets requiresApproval for voice_call, legal_notice and odr_pack only", () => {
      const approval = LADDER_STEPS.map((step, index) => {
        const previous = LADDER_STEPS[index - 1];
        const history: EscalationHistory =
          previous === undefined ? [] : [stepEvent(previous, "2026-10-18")];
        const decision = nextEscalationStep(sharmaTradersInvoice, history, "2026-10-30");
        return decision.action === "advance"
          ? { step: decision.step, requiresApproval: decision.requiresApproval }
          : undefined;
      });
      expect(approval).toStrictEqual([
        { step: "whatsapp_nudge", requiresApproval: false },
        { step: "whatsapp_paylink", requiresApproval: false },
        { step: "voice_call", requiresApproval: true },
        { step: "legal_notice", requiresApproval: true },
        { step: "odr_pack", requiresApproval: true },
      ]);
    });

    it("advances from rank 3 to rank 4 when the history holds only a voice call", () => {
      const history: EscalationHistory = [stepEvent("voice_call", "2026-10-20")];
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-10-30")).toMatchObject({
        action: "advance",
        step: "legal_notice",
        rank: 4,
        requiresApproval: true,
      });
    });
  });

  describe("cooldown", () => {
    it("waits when the last step was 3 days ago and the gap is 7", () => {
      const history: EscalationHistory = [stepEvent("whatsapp_nudge", "2026-10-25")];
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-10-28")).toStrictEqual({
        action: "wait",
        applicable: true,
        reason: "cooldown",
        ruleIds: [],
      });
    });

    it("advances once exactly stepGapDays have passed", () => {
      const history: EscalationHistory = [stepEvent("whatsapp_nudge", "2026-10-25")];
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-11-01")).toMatchObject({
        action: "advance",
        step: "whatsapp_paylink",
      });
    });

    it("uses a custom stepGapDays from the config", () => {
      const history: EscalationHistory = [stepEvent("whatsapp_nudge", "2026-10-25")];
      expect(
        nextEscalationStep(sharmaTradersInvoice, history, "2026-10-28", { stepGapDays: 3 }),
      ).toMatchObject({ action: "advance", step: "whatsapp_paylink" });
    });

    it("measures the cooldown from the latest step date, not the last array element", () => {
      const history: EscalationHistory = [
        stepEvent("whatsapp_nudge", "2026-10-25"),
        stepEvent("whatsapp_paylink", "2026-10-18"),
      ];
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-10-28")).toMatchObject({
        action: "wait",
        reason: "cooldown",
      });
    });
  });

  describe("promises", () => {
    const history: EscalationHistory = [
      stepEvent("whatsapp_nudge", "2026-10-18"),
      promiseEvent("2026-11-05", "2026-10-20"),
    ];

    it("waits with promise_active while the promised date is in the future", () => {
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-11-01")).toStrictEqual({
        action: "wait",
        applicable: true,
        reason: "promise_active",
        ruleIds: [],
      });
    });

    it("resumes at maxRank + 1 once the promised date has passed", () => {
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-11-06")).toMatchObject({
        action: "advance",
        step: "whatsapp_paylink",
        rank: 2,
      });
    });
  });

  describe("future-dated history events", () => {
    it("ignores a step dated after today and a promise recorded after today", () => {
      // Today is 2026-10-30, 13 days past the due date. Both events are dated later.
      // If the step counted, the ladder would advance to rank 3; if the promise counted, it would wait.
      const history: EscalationHistory = [
        stepEvent("whatsapp_paylink", "2026-11-05"),
        promiseEvent("2026-11-20", "2026-11-02"),
      ];
      const decision = nextEscalationStep(sharmaTradersInvoice, history, "2026-10-30");
      expect(decision).toStrictEqual({
        action: "advance",
        applicable: true,
        step: "whatsapp_nudge",
        rank: 1,
        requiresApproval: false,
        ruleIds: ["MSMED-15"],
      });
      expect(decision).toStrictEqual(nextEscalationStep(sharmaTradersInvoice, [], "2026-10-30"));
    });
  });

  describe("wait reason precedence", () => {
    it("reports paid before promise_active", () => {
      const paid = invoiceWith({ paidOn: "2026-10-25" });
      const history: EscalationHistory = [promiseEvent("2026-11-05", "2026-10-20")];
      expect(nextEscalationStep(paid, history, "2026-11-01")).toStrictEqual({
        action: "wait",
        applicable: true,
        reason: "paid",
        ruleIds: [],
      });
    });

    it("treats a payment dated after today as unpaid", () => {
      const paidLater = invoiceWith({ paidOn: "2026-12-01" });
      expect(nextEscalationStep(paidLater, [], "2026-10-30")).toMatchObject({
        action: "advance",
        step: "whatsapp_nudge",
      });
    });

    it("reports ladder_complete even inside the cooldown window", () => {
      const history: EscalationHistory = [stepEvent("odr_pack", "2026-10-30")];
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-11-01")).toStrictEqual({
        action: "wait",
        applicable: true,
        reason: "ladder_complete",
        ruleIds: [],
      });
    });

    it("reports not_overdue before promise_active", () => {
      const history: EscalationHistory = [promiseEvent("2026-11-05", "2026-10-10")];
      expect(nextEscalationStep(sharmaTradersInvoice, history, "2026-10-15")).toMatchObject({
        action: "wait",
        reason: "not_overdue",
      });
    });
  });

  describe("coverage", () => {
    it("waits with the trader reason and only MSMED-SCOPE for a micro trader", () => {
      const trader = invoiceWith({ supplierActivity: "trading" });
      expect(nextEscalationStep(trader, [], "2026-10-30")).toStrictEqual({
        action: "wait",
        applicable: false,
        reason: "trader",
        ruleIds: ["MSMED-SCOPE"],
      });
    });

    it("prefers medium_or_unregistered over trader", () => {
      const mediumTrader = invoiceWith({ supplierCategory: "medium", supplierActivity: "trading" });
      expect(nextEscalationStep(mediumTrader, [], "2026-10-30")).toStrictEqual({
        action: "wait",
        applicable: false,
        reason: "medium_or_unregistered",
        ruleIds: ["MSMED-SCOPE"],
      });
    });

    it("returns paid with applicable false and no rule IDs for a paid non-covered invoice", () => {
      const paidTrader = invoiceWith({ supplierActivity: "trading", paidOn: "2026-10-01" });
      expect(nextEscalationStep(paidTrader, [], "2026-10-30")).toStrictEqual({
        action: "wait",
        applicable: false,
        reason: "paid",
        ruleIds: [],
      });
    });

    it("adds the caveat and MSMED-SCOPE to an advance when registered after supply", () => {
      const late = invoiceWith({ udyamRegisteredOn: "2026-09-10" });
      expect(nextEscalationStep(late, [], "2026-10-18")).toStrictEqual({
        action: "advance",
        applicable: true,
        step: "whatsapp_nudge",
        rank: 1,
        requiresApproval: false,
        ruleIds: ["MSMED-15", "MSMED-SCOPE"],
        caveat: "registered_after_supply",
      });
    });

    it("adds the caveat and MSMED-SCOPE to a wait when registered after supply", () => {
      const late = invoiceWith({ udyamRegisteredOn: "2026-09-10" });
      expect(nextEscalationStep(late, [], "2026-10-17")).toStrictEqual({
        action: "wait",
        applicable: true,
        reason: "not_overdue",
        ruleIds: ["MSMED-SCOPE"],
        caveat: "registered_after_supply",
      });
    });

    it("keeps MSMED-18 and MSMED-ODR on a late-registered ODR pack advance", () => {
      const late = invoiceWith({ udyamRegisteredOn: "2026-09-10" });
      const history: EscalationHistory = [stepEvent("legal_notice", "2026-10-20")];
      const decision = nextEscalationStep(late, history, "2026-11-01");
      expect(decision).toMatchObject({ action: "advance", step: "odr_pack", caveat: "registered_after_supply" });
      // MSMED-SCOPE sorts between MSMED-18 and MSMED-ODR (RULE_IDS order).
      expect(decision.ruleIds).toEqual(["MSMED-15", "MSMED-18", "MSMED-SCOPE", "MSMED-ODR"]);
    });
  });
});

describe("exported ladder constants are immutable", () => {
  it("freezes LADDER_STEPS and APPROVAL_STEP_LIST", () => {
    expect(Object.isFrozen(LADDER_STEPS)).toBe(true);
    expect(Object.isFrozen(APPROVAL_STEP_LIST)).toBe(true);
  });

  it("lists the approval steps in ladder order and answers isApprovalStep to match", () => {
    expect(APPROVAL_STEP_LIST).toStrictEqual(["voice_call", "legal_notice", "odr_pack"]);
    expect(LADDER_STEPS.map((step) => isApprovalStep(step))).toStrictEqual([false, false, true, true, true]);
  });

  it("is unchanged by mutation attempts in non-strict code", () => {
    // ES modules are always strict, so run the mutations in a sloppy-mode function.
    // Index writes and `length` writes to a frozen array are then silent no-ops; `push` still throws.
    const sloppyMutate = new Function(
      "ladderSteps",
      "approvalSteps",
      `
      ladderSteps[0] = "odr_pack";
      ladderSteps[4] = "whatsapp_nudge";
      ladderSteps.length = 0;
      approvalSteps[1] = "whatsapp_nudge";
      approvalSteps.length = 0;
      try { ladderSteps.push("extra"); } catch (e) {}
      try { approvalSteps.push("extra"); } catch (e) {}
      try { ladderSteps.pop(); } catch (e) {}
      try { approvalSteps.pop(); } catch (e) {}
      `,
    ) as (ladderSteps: unknown, approvalSteps: unknown) => void;
    expect(new Function("return typeof this")()).toBe("object"); // sloppy mode: `this` is the global object

    sloppyMutate(LADDER_STEPS, APPROVAL_STEP_LIST);

    expect(LADDER_STEPS).toStrictEqual(["whatsapp_nudge", "whatsapp_paylink", "voice_call", "legal_notice", "odr_pack"]);
    expect(APPROVAL_STEP_LIST).toStrictEqual(["voice_call", "legal_notice", "odr_pack"]);

    // An empty-history evaluation still starts at rank 1.
    expect(nextEscalationStep(sharmaTradersInvoice, [], "2026-10-18")).toStrictEqual({
      action: "advance",
      applicable: true,
      step: "whatsapp_nudge",
      rank: 1,
      requiresApproval: false,
      ruleIds: ["MSMED-15"],
    });

    // legal_notice (rank 4) still needs approval.
    const afterVoiceCall: EscalationHistory = [stepEvent("voice_call", "2026-10-20")];
    expect(nextEscalationStep(sharmaTradersInvoice, afterVoiceCall, "2026-10-30")).toStrictEqual({
      action: "advance",
      applicable: true,
      step: "legal_notice",
      rank: 4,
      requiresApproval: true,
      ruleIds: ["MSMED-15"],
    });
    expect(isApprovalStep("legal_notice")).toBe(true);
  });
});
