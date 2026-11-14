// Feature: escalation-ladder, Property 6: Run planning follows the Decision, the due date and the cap
// Validates: Requirements 1.3, 1.4, 1.5, 1.8, 1.10, 1.11, 1.12, 2.2
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  CalendarDate,
  CoveredWaitReason,
  EscalationDecision,
  LadderStep,
  NonCoverageReason,
  WaitReason,
} from "@dues-banshee/engine";
import { MAX_DRAFTS_PER_RUN, classify, planRun } from "../src/core/plan-run";
import type { Classified, DraftableItem } from "../src/core/plan-run";

const NUM_RUNS = 100;

// The Engine exports WaitReason only as a type, so list the members here. The Record keeps the
// lists exhaustive: adding a reason to the Engine type fails typecheck until it is added here.
const COVERED_WAIT_REASONS = Object.keys({
  paid: 0,
  not_overdue: 0,
  promise_active: 0,
  ladder_complete: 0,
  cooldown: 0,
} satisfies Record<CoveredWaitReason, 0>) as CoveredWaitReason[];

const NON_COVERAGE_REASONS = Object.keys({
  medium_or_unregistered: 0,
  trader: 0,
} satisfies Record<NonCoverageReason, 0>) as NonCoverageReason[];

const LADDER_STEPS: LadderStep[] = [
  "whatsapp_nudge",
  "whatsapp_paylink",
  "voice_call",
  "legal_notice",
  "odr_pack",
];

const arbStepRank = fc.integer({ min: 0, max: 4 });

const arbWaitDecision: fc.Arbitrary<Extract<EscalationDecision, { action: "wait" }>> = fc.oneof(
  fc.constantFrom(...COVERED_WAIT_REASONS).map(
    (reason): Extract<EscalationDecision, { action: "wait" }> => ({
      action: "wait",
      applicable: true,
      reason,
      ruleIds: [],
    }),
  ),
  fc.constantFrom(...NON_COVERAGE_REASONS).map(
    (reason): Extract<EscalationDecision, { action: "wait" }> => ({
      action: "wait",
      applicable: false,
      reason,
      ruleIds: ["MSMED-SCOPE"],
    }),
  ),
);

const arbAdvanceDecision: fc.Arbitrary<Extract<EscalationDecision, { action: "advance" }>> =
  arbStepRank.map((i) => ({
    action: "advance",
    applicable: true,
    step: LADDER_STEPS[i]!,
    rank: (i + 1) as 1 | 2 | 3 | 4 | 5,
    requiresApproval: i >= 2,
    ruleIds: ["MSMED-15"],
  }));

/** A calendar date in a narrow range, so equal due dates (ties) are common. */
const arbDueDate: fc.Arbitrary<CalendarDate> = fc
  .integer({ min: 0, max: 40 })
  .map((offset) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10));

const arbInvoiceId = fc.string({ minLength: 1, maxLength: 5 });
const arbPendingDraftId = fc.string({ minLength: 1, maxLength: 8 });

const arbDraftable: fc.Arbitrary<DraftableItem> = fc.record({
  invoiceId: arbInvoiceId,
  kind: fc.constant("draftable" as const),
  step: fc.constantFrom(...LADDER_STEPS),
  dueDate: arbDueDate,
});

const arbNonDraftable: fc.Arbitrary<Exclude<Classified, DraftableItem>> = fc.oneof(
  fc.record({
    invoiceId: arbInvoiceId,
    kind: fc.constant("wait" as const),
    reason: fc.constantFrom<WaitReason>(...COVERED_WAIT_REASONS, ...NON_COVERAGE_REASONS),
  }),
  fc.record({
    invoiceId: arbInvoiceId,
    kind: fc.constant("skip" as const),
    reason: fc.constantFrom("pending_draft_exists" as const, "invalid_invoice" as const),
  }),
);

/** Mixed run input with unique invoice ids; up to 45 items so the cap is often exceeded. */
const arbItems: fc.Arbitrary<Classified[]> = fc.uniqueArray(
  fc.oneof({ arbitrary: arbDraftable, weight: 3 }, { arbitrary: arbNonDraftable, weight: 1 }),
  { selector: (item) => item.invoiceId, minLength: 0, maxLength: 45 },
);

/** Only draftable items, enough of them to exceed the cap. */
const arbDraftables = (minLength: number, maxLength: number): fc.Arbitrary<DraftableItem[]> =>
  fc.uniqueArray(arbDraftable, { selector: (item) => item.invoiceId, minLength, maxLength });

function oracleOrder(items: readonly Classified[]): DraftableItem[] {
  return items
    .filter((item): item is DraftableItem => item.kind === "draftable")
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.invoiceId !== b.invoiceId) return a.invoiceId < b.invoiceId ? -1 : 1;
      return 0;
    });
}

describe("Property 6: Run planning follows the Decision, the due date and the cap", () => {
  it("MAX_DRAFTS_PER_RUN is 20", () => {
    expect(MAX_DRAFTS_PER_RUN).toBe(20);
  });

  it("classify of any wait Decision yields wait with that reason, whatever the pending Draft or due date", () => {
    fc.assert(
      fc.property(
        arbWaitDecision,
        fc.option(arbPendingDraftId, { nil: null }),
        fc.option(arbDueDate, { nil: null }),
        (decision, pendingDraftId, due) => {
          const result = classify(decision, pendingDraftId, due);
          expect(result).toEqual({ kind: "wait", reason: decision.reason });
          expect(result.kind).not.toBe("draftable");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("classify covers every wait reason, including promise_active", () => {
    for (const reason of [...COVERED_WAIT_REASONS, ...NON_COVERAGE_REASONS]) {
      const covered = (COVERED_WAIT_REASONS as string[]).includes(reason);
      const decision = (
        covered
          ? { action: "wait", applicable: true, reason, ruleIds: [] }
          : { action: "wait", applicable: false, reason, ruleIds: ["MSMED-SCOPE"] }
      ) as EscalationDecision;
      expect(classify(decision, "draft-1", "2026-01-10")).toEqual({ kind: "wait", reason });
      expect(classify(decision, null, "2026-01-10")).toEqual({ kind: "wait", reason });
    }
    expect(COVERED_WAIT_REASONS).toContain("promise_active");
  });

  it("classify of advance with a pending Draft id skips as pending_draft_exists", () => {
    fc.assert(
      fc.property(
        arbAdvanceDecision,
        arbPendingDraftId,
        fc.option(arbDueDate, { nil: null }),
        (decision, pendingDraftId, due) => {
          expect(classify(decision, pendingDraftId, due)).toEqual({
            kind: "skip",
            reason: "pending_draft_exists",
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("classify of advance with no pending Draft is draftable with the Decision's step and the due date", () => {
    fc.assert(
      fc.property(arbAdvanceDecision, arbDueDate, (decision, due) => {
        expect(classify(decision, null, due)).toEqual({
          kind: "draftable",
          step: decision.step,
          dueDate: due,
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("classify of advance with no pending Draft and no due date is skipped as invalid_invoice", () => {
    fc.assert(
      fc.property(arbAdvanceDecision, (decision) => {
        expect(classify(decision, null, null)).toEqual({ kind: "skip", reason: "invalid_invoice" });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("planRun attempts are the first min(20, n) draftable items sorted by (dueDate, invoiceId)", () => {
    fc.assert(
      fc.property(arbItems, (items) => {
        const sorted = oracleOrder(items);
        const { attempts } = planRun(items);
        expect(attempts).toEqual(sorted.slice(0, Math.min(MAX_DRAFTS_PER_RUN, sorted.length)));
        expect(attempts.length).toBeLessThanOrEqual(MAX_DRAFTS_PER_RUN);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("planRun capped holds the remaining draftable ids in order", () => {
    fc.assert(
      fc.property(arbItems, (items) => {
        const sorted = oracleOrder(items);
        const { capped } = planRun(items);
        expect(capped).toEqual(sorted.slice(MAX_DRAFTS_PER_RUN).map((item) => item.invoiceId));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("attempts and capped partition the draftable items with no loss and no duplicates", () => {
    fc.assert(
      fc.property(arbItems, (items) => {
        const draftableIds = items.filter((i) => i.kind === "draftable").map((i) => i.invoiceId);
        const { attempts, capped } = planRun(items);
        const planned = [...attempts.map((a) => a.invoiceId), ...capped];
        expect(planned).toHaveLength(draftableIds.length);
        expect(new Set(planned).size).toBe(planned.length);
        expect([...planned].sort()).toEqual([...draftableIds].sort());
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("non-draftable items never appear in attempts or capped", () => {
    fc.assert(
      fc.property(arbItems, (items) => {
        const nonDraftableIds = new Set(
          items.filter((i) => i.kind !== "draftable").map((i) => i.invoiceId),
        );
        const { attempts, capped } = planRun(items);
        for (const attempt of attempts) {
          expect(attempt.kind).toBe("draftable");
          expect(nonDraftableIds.has(attempt.invoiceId)).toBe(false);
        }
        for (const id of capped) expect(nonDraftableIds.has(id)).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("planRun does not mutate its input", () => {
    fc.assert(
      fc.property(arbItems, (items) => {
        const snapshot = structuredClone(items);
        for (const item of items) Object.freeze(item);
        Object.freeze(items);
        planRun(items);
        expect(items).toEqual(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("exactly 21 draftable items give 20 attempts and 1 capped", () => {
    fc.assert(
      fc.property(arbDraftables(21, 21), (items) => {
        const { attempts, capped } = planRun(items);
        expect(attempts).toHaveLength(20);
        expect(capped).toHaveLength(1);
        expect(capped[0]).toBe(oracleOrder(items)[20]!.invoiceId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("20 or fewer draftable items give no capped invoices", () => {
    fc.assert(
      fc.property(arbDraftables(0, 20), (items) => {
        const { attempts, capped } = planRun(items);
        expect(attempts).toHaveLength(items.length);
        expect(capped).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
