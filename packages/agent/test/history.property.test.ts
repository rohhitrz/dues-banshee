// Feature: escalation-ladder, Property 7: Engine_History counts only approved steps
// Validates: Requirements 2.1, 7.5
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LADDER_STEPS, nextEscalationStep } from "@dues-banshee/engine";
import type { EscalationEvent } from "@dues-banshee/engine";
import type { EscalationAction, LadderRecord } from "@dues-banshee/db";
import { arbCalendarDate, arbCoveredInvoice, arbLadderConfig, arbToday } from "../../engine/test/arbitraries";
import { engineHistory } from "../src/core/history";

const ACTIONS: readonly EscalationAction[] = ["drafted", "edited", "approved", "rejected", "expired", "sent"];

type HistoryInput = Pick<LadderRecord, "steps" | "promises">;
type StepRow = LadderRecord["steps"][number];
type PromiseRow = LadderRecord["promises"][number];

const arbStepRow: fc.Arbitrary<StepRow> = fc.record({
  step: fc.constantFrom(...LADDER_STEPS),
  occurredOn: arbCalendarDate(),
  action: fc.constantFrom(...ACTIONS),
  draftId: fc.option(fc.uuid(), { nil: null }),
});

const arbPromiseRow: fc.Arbitrary<PromiseRow> = fc.record({
  promisedDate: arbCalendarDate(),
  amountPaise: fc.integer({ min: 1, max: 1_000_000_000_000 }),
  recordedOn: arbCalendarDate(),
});

const arbRecord: fc.Arbitrary<HistoryInput> = fc.record({
  steps: fc.array(arbStepRow, { maxLength: 12 }),
  promises: fc.array(arbPromiseRow, { maxLength: 6 }),
});

describe("Property 7: Engine_History counts only approved steps", () => {
  it("has one step event per approved step and one promise event per promise, nothing else", () => {
    fc.assert(
      fc.property(arbRecord, (record) => {
        const history = engineHistory(record);

        const stepEvents = history.filter((e) => e.kind === "step");
        const promiseEvents = history.filter((e) => e.kind === "promise");

        // Exactly the approved steps, same step and date, same order.
        const expectedSteps: EscalationEvent[] = record.steps
          .filter((s) => s.action === "approved")
          .map((s) => ({ kind: "step", step: s.step, on: s.occurredOn }));
        expect(stepEvents).toEqual(expectedSteps);

        // Exactly the promises, all three fields carried over, same order.
        const expectedPromises: EscalationEvent[] = record.promises.map((p) => ({
          kind: "promise",
          promisedDate: p.promisedDate,
          amountPaise: p.amountPaise,
          recordedOn: p.recordedOn,
        }));
        expect(promiseEvents).toEqual(expectedPromises);

        // Nothing else: no events for drafted, edited, rejected or expired steps.
        expect(history).toHaveLength(expectedSteps.length + expectedPromises.length);
      }),
      { numRuns: 100 },
    );
  });

  it("gives the same Engine decision with or without non-approved steps in the record", () => {
    const arbScenario = arbCoveredInvoice.chain((invoice) =>
      fc.record({
        invoice: fc.constant(invoice),
        record: arbRecord,
        today: arbToday(invoice),
        config: arbLadderConfig,
      }),
    );

    fc.assert(
      fc.property(arbScenario, ({ invoice, record, today, config }) => {
        const approvedOnly: HistoryInput = {
          steps: record.steps.filter((s) => s.action === "approved"),
          promises: record.promises,
        };

        const withAll = nextEscalationStep(invoice, engineHistory(record), today, config);
        const filtered = nextEscalationStep(invoice, engineHistory(approvedOnly), today, config);

        expect(withAll).toEqual(filtered);
      }),
      { numRuns: 100 },
    );
  });
});
