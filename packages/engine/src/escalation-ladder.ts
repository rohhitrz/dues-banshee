import { compareDates, dayDifference } from "./calendar-date";
import { coverage, withCaveat } from "./coverage";
import { dueDate } from "./due-date";
import type { RuleId } from "./rule-ids";
import type {
  CalendarDate,
  CoveredWaitReason,
  EscalationDecision,
  EscalationHistory,
  Invoice,
  LadderConfig,
  LadderStep,
} from "./types";
import { assertCalendarDate, validateHistory, validateInvoice, validateLadderConfig } from "./validate";

/** The five escalation steps in order, rank 1 to 5. */
export const LADDER_STEPS = [
  "whatsapp_nudge",
  "whatsapp_paylink",
  "voice_call",
  "legal_notice",
  "odr_pack",
] as const satisfies readonly LadderStep[];

type Rank = 1 | 2 | 3 | 4 | 5;

const RANKS: Readonly<Record<LadderStep, Rank>> = {
  whatsapp_nudge: 1,
  whatsapp_paylink: 2,
  voice_call: 3,
  legal_notice: 4,
  odr_pack: 5,
};

/** Rank of a ladder step: 1 (`whatsapp_nudge`) to 5 (`odr_pack`). */
export function stepRank(step: LadderStep): Rank {
  return RANKS[step];
}

/** Steps that need the owner's explicit approval before the agent acts. */
export const APPROVAL_STEPS: ReadonlySet<LadderStep> = new Set<LadderStep>([
  "voice_call",
  "legal_notice",
  "odr_pack",
]);

/** Minimum days between two consecutive ladder steps. */
export const DEFAULT_STEP_GAP_DAYS = 7;

type CoveredWait = Extract<EscalationDecision, { action: "wait"; reason: CoveredWaitReason }>;
type Advance = Extract<EscalationDecision, { action: "advance" }>;

/** Rules behind an advance: the invoice is past its MSMED-15 date; the ODR pack also relies on s.18 and the portal. */
function advanceRuleIds(step: LadderStep): RuleId[] {
  return step === "odr_pack" ? ["MSMED-15", "MSMED-18", "MSMED-ODR"] : ["MSMED-15"];
}

/**
 * Decides the next escalation step for one invoice. Wait reasons are checked
 * in a fixed order and the first that applies wins: paid, not covered,
 * not_overdue, promise_active, ladder_complete, cooldown. Otherwise the ladder
 * advances one rank above the highest step already taken (rank 1 if none).
 * History events dated after `today` have not happened yet and are ignored.
 */
export function nextEscalationStep(
  invoice: Invoice,
  history: EscalationHistory,
  today: CalendarDate,
  config: LadderConfig = { stepGapDays: DEFAULT_STEP_GAP_DAYS },
): EscalationDecision {
  validateInvoice(invoice);
  assertCalendarDate("today", today);
  validateHistory(history);
  validateLadderConfig(config);

  const cov = coverage(invoice);
  const wait = (reason: CoveredWaitReason): CoveredWait =>
    withCaveat({ action: "wait", applicable: true, reason, ruleIds: [] }, cov);

  // 1. Paid. A paid non-covered invoice still reports `paid`, citing no rule.
  if (invoice.paidOn !== undefined && compareDates(invoice.paidOn, today) <= 0) {
    return cov.applicable
      ? wait("paid")
      : { action: "wait", applicable: false, reason: "paid", ruleIds: [] };
  }

  // 2. Not covered.
  if (!cov.applicable) {
    return { ...cov, action: "wait" };
  }

  // 3. Not overdue.
  const due = dueDate(invoice);
  if (!due.applicable) {
    // Unreachable: dueDate uses the same coverage check.
    return { ...due, action: "wait" };
  }
  if (compareDates(today, due.dueDate) <= 0) {
    return wait("not_overdue");
  }

  // Only events that have happened by `today` count.
  let maxRank = 0;
  let latestStepOn: CalendarDate | undefined;
  let promiseActive = false;
  for (const event of history) {
    if (event.kind === "step") {
      if (compareDates(event.on, today) > 0) continue;
      maxRank = Math.max(maxRank, stepRank(event.step));
      if (latestStepOn === undefined || compareDates(event.on, latestStepOn) > 0) {
        latestStepOn = event.on;
      }
    } else if (compareDates(event.recordedOn, today) <= 0 && compareDates(event.promisedDate, today) > 0) {
      promiseActive = true;
    }
  }

  // 4. Active promise.
  if (promiseActive) {
    return wait("promise_active");
  }

  // 5. Ladder complete: no step above the highest rank.
  const step = LADDER_STEPS[maxRank];
  if (step === undefined) {
    return wait("ladder_complete");
  }

  // 6. Cooldown since the latest step, by date and not by array position.
  if (latestStepOn !== undefined && dayDifference(latestStepOn, today) < config.stepGapDays) {
    return wait("cooldown");
  }

  // 7. Advance.
  const advance: Advance = {
    action: "advance",
    applicable: true,
    step,
    rank: stepRank(step),
    requiresApproval: APPROVAL_STEPS.has(step),
    ruleIds: advanceRuleIds(step),
  };
  return withCaveat(advance, cov);
}
