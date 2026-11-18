import type { EscalationHistory } from "@dues-banshee/engine";
import type { LadderRecord } from "@dues-banshee/db";
import { engineHistory } from "../core/history";

/**
 * The Engine history for the Send_Check: the invoice's other approved steps and its promises, without
 * the approved event of the Draft being sent. Every non-`approved` action (including `sent`) is
 * already dropped by `engineHistory` (Req 2.4, 5.5).
 */
export function sendCheckHistory(
  record: Pick<LadderRecord, "steps" | "promises">,
  draftId: string,
): EscalationHistory {
  return engineHistory({
    steps: record.steps.filter((s) => s.draftId !== draftId),
    promises: record.promises,
  });
}
