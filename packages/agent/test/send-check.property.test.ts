// Feature: whatsapp-channel, Property 3: Send_Check sees only other approved steps and promises
// Validates: Requirements 2.4, 5.5
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LADDER_STEPS, nextEscalationStep } from "@dues-banshee/engine";
import type { EscalationEvent } from "@dues-banshee/engine";
import type { EscalationAction, LadderRecord } from "@dues-banshee/db";
import { arbCalendarDate, arbCoveredInvoice, arbLadderConfig, arbToday } from "../../engine/test/arbitraries";
import { engineHistory } from "../src/core/history";
import { sendCheckHistory } from "../src/channel/send-check";

const ACTIONS: readonly EscalationAction[] = ["drafted", "edited", "approved", "rejected", "expired", "sent"];
/** A small pool, so the sent Draft id collides with step rows often. */
const DRAFT_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

type Record_ = Pick<LadderRecord, "steps" | "promises">;
type StepRow = LadderRecord["steps"][number];
type PromiseRow = LadderRecord["promises"][number];

const arbStepRow: fc.Arbitrary<StepRow> = fc.record({
  step: fc.constantFrom(...LADDER_STEPS),
  occurredOn: arbCalendarDate(),
  action: fc.constantFrom(...ACTIONS),
  draftId: fc.option(fc.constantFrom(...DRAFT_IDS), { nil: null }),
});
const arbPromiseRow: fc.Arbitrary<PromiseRow> = fc.record({
  promisedDate: arbCalendarDate(),
  amountPaise: fc.integer({ min: 1, max: 1_000_000_000_000 }),
  recordedOn: arbCalendarDate(),
});
const arbRecord: fc.Arbitrary<Record_> = fc.record({
  steps: fc.array(arbStepRow, { maxLength: 12 }),
  promises: fc.array(arbPromiseRow, { maxLength: 6 }),
});
const arbDraftId = fc.constantFrom(...DRAFT_IDS);

describe("Property 3: Send_Check sees only other approved steps and promises", () => {
  it("is the other Drafts' approved steps and every promise, nothing else", () => {
    fc.assert(
      fc.property(arbRecord, arbDraftId, (record, draftId) => {
        const expected: EscalationEvent[] = [
          ...record.steps
            .filter((s) => s.action === "approved" && s.draftId !== draftId)
            .map((s): EscalationEvent => ({ kind: "step", step: s.step, on: s.occurredOn })),
          ...record.promises.map(
            (p): EscalationEvent => ({
              kind: "promise",
              promisedDate: p.promisedDate,
              amountPaise: p.amountPaise,
              recordedOn: p.recordedOn,
            }),
          ),
        ];
        expect(sendCheckHistory(record, draftId)).toEqual(expected);
        // Equals the Engine history of the record with the Draft's step rows removed.
        expect(sendCheckHistory(record, draftId)).toEqual(
          engineHistory({ steps: record.steps.filter((s) => s.draftId !== draftId), promises: record.promises }),
        );
      }),
      { numRuns: 100 },
    );
  });

  it("gives the same Engine decision with or without non-approved rows", () => {
    const arbScenario = arbCoveredInvoice.chain((invoice) =>
      fc.record({
        invoice: fc.constant(invoice),
        record: arbRecord,
        draftId: arbDraftId,
        today: arbToday(invoice),
        config: arbLadderConfig,
      }),
    );
    fc.assert(
      fc.property(arbScenario, ({ invoice, record, draftId, today, config }) => {
        const approvedOnly: Record_ = {
          steps: record.steps.filter((s) => s.action === "approved"),
          promises: record.promises,
        };
        expect(nextEscalationStep(invoice, sendCheckHistory(record, draftId), today, config)).toEqual(
          nextEscalationStep(invoice, sendCheckHistory(approvedOnly, draftId), today, config),
        );
        expect(nextEscalationStep(invoice, engineHistory(record), today, config)).toEqual(
          nextEscalationStep(invoice, engineHistory(approvedOnly), today, config),
        );
      }),
      { numRuns: 100 },
    );
  });
});
