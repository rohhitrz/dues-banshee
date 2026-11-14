import type {
  EscalationDecision,
  LadderStep,
  NonCoverageReason,
  WaitReason,
} from "@dues-banshee/engine";

export type TombstoneState =
  | "resurrected"
  | "not_covered"
  | "not_due"
  | "exploded"
  | "armed"
  | "overdue";

export const STEP_TEXT = {
  whatsapp_nudge: "WhatsApp nudge",
  whatsapp_paylink: "WhatsApp + UPI link",
  voice_call: "Voice call",
  legal_notice: "Legal notice",
  odr_pack: "MSME ODR pack",
} as const satisfies Record<LadderStep, string>;

export const WAIT_TEXT = {
  paid: "Paid",
  not_overdue: "Not due yet",
  promise_active: "Promise to pay active",
  cooldown: "Gap since last step",
  ladder_complete: "All steps done",
  medium_or_unregistered: "Not a Udyam micro/small supplier",
  trader: "Trader, outside MSMED",
} as const satisfies Record<WaitReason, string>;

/** "Next: <step>" for an advance decision, "Waiting: <reason>" for a wait. */
export function nextStepLabel(d: EscalationDecision): string {
  return d.action === "advance"
    ? `Next: ${STEP_TEXT[d.step]}`
    : `Waiting: ${WAIT_TEXT[d.reason]}`;
}

export interface StateTextInput {
  state: TombstoneState;
  /** Days left to the tax-bomb date; used only for the `armed` state. */
  daysLeft: number;
  /** Used only for the `not_covered` state. */
  nonCoverageReason: NonCoverageReason | null;
}

export function stateText({
  state,
  daysLeft,
  nonCoverageReason,
}: StateTextInput): string {
  switch (state) {
    case "not_due":
      return "Not due yet";
    case "overdue":
      return "Overdue, interest accruing";
    case "armed":
      return `Tax bomb armed: ${daysLeft} days left to 31 March`;
    case "exploded":
      return "Tax bomb exploded";
    case "resurrected":
      return "Resurrected (paid)";
    case "not_covered":
      return nonCoverageReason === null
        ? "Outside MSMED"
        : `Outside MSMED (${WAIT_TEXT[nonCoverageReason]})`;
  }
}

/**
 * The overdue line of a plaque or panel, or null when the state shows none. Shown only for `overdue`,
 * `armed` and `exploded`; `overdue` has no "interest accruing" suffix because its stateText says so.
 */
export function overdueText(view: { state: TombstoneState; daysOverdue: number }): string | null {
  if (view.state !== "overdue" && view.state !== "armed" && view.state !== "exploded") return null;
  return view.state === "overdue"
    ? `Overdue ${view.daysOverdue} days`
    : `Overdue ${view.daysOverdue} days, interest accruing`;
}
