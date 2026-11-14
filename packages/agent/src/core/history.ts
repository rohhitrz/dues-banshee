import type { EscalationEvent, EscalationHistory } from "@dues-banshee/engine";
import type { LadderRecord } from "@dues-banshee/db";

/**
 * The Engine history for one invoice: one StepEvent per `approved` step and one PromiseEvent per
 * promise. Drafted, edited, rejected and expired steps are dropped (Req 2.1, 7.5).
 */
export function engineHistory(r: Pick<LadderRecord, "steps" | "promises">): EscalationHistory {
  const events: EscalationEvent[] = [];
  for (const s of r.steps) {
    if (s.action === "approved") events.push({ kind: "step", step: s.step, on: s.occurredOn });
  }
  for (const p of r.promises) {
    events.push({
      kind: "promise",
      promisedDate: p.promisedDate,
      amountPaise: p.amountPaise,
      recordedOn: p.recordedOn,
    });
  }
  return events;
}
