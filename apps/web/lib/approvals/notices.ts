import type { EscalationDecision, LadderStep, WaitReason } from "@dues-banshee/engine";
import { STEP_TEXT, WAIT_TEXT } from "@/lib/graveyard/labels";

/**
 * Messages the Approval_Queue shows after an action. An action redirects back to `/approvals` with
 * `?notice=<code>` (plus `label` or `n`), and the page maps the code to the fixed text here. Nothing
 * from the URL is shown as free text, so a crafted link can only select one of these messages.
 */
export const NOTICE_CODES = [
  "approved",
  "saved",
  "rejected",
  "redrafted",
  "expired",
  "empty_body",
  "already_decided",
  "not_found",
  "draft_failed",
  "ladder_checked",
  "ladder_failed",
] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];

export const NOTICE_TEXT = {
  approved: "Draft approved. Nothing is sent yet.",
  saved: "Edit saved.",
  rejected: "Draft rejected.",
  redrafted: "New draft ready for your review.",
  expired: "This draft is out of date",
  empty_body: "The message can't be empty",
  already_decided: "This draft was already decided",
  not_found: "Draft not found",
  draft_failed: "Could not write a new draft. Try again.",
  ladder_checked: "Ladder checked",
  ladder_failed: "Could not check the ladder. Try again.",
} as const satisfies Record<NoticeCode, string>;

/** The label of the Decision that made a Draft out of date: the Wait_Text or the Step_Text. */
export function decisionLabelKey(decision: EscalationDecision): string {
  return decision.action === "advance" ? `step:${decision.step}` : `wait:${decision.reason}`;
}

function isKey<T extends object>(table: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(table, key);
}

/** Text for a label key made by `decisionLabelKey`; null when the key is not a known one. */
export function labelFromKey(key: string | undefined): string | null {
  if (key === undefined) return null;
  const [kind, name = ""] = key.split(":");
  if (kind === "step" && isKey(STEP_TEXT, name)) return STEP_TEXT[name as LadderStep];
  if (kind === "wait" && isKey(WAIT_TEXT, name)) return WAIT_TEXT[name as WaitReason];
  return null;
}

const SUCCESS_CODES: readonly NoticeCode[] = ["approved", "saved", "rejected", "redrafted", "ladder_checked"];

export interface NoticeParams {
  notice?: string | string[];
  label?: string | string[];
  n?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The message to show for the URL's notice params, or null when there is none or it is unknown. */
export function noticeMessage(
  params: NoticeParams,
): { code: NoticeCode; text: string; isError: boolean } | null {
  const code = first(params.notice);
  if (code === undefined || !isKey(NOTICE_TEXT, code)) return null;
  const isError = !SUCCESS_CODES.includes(code);
  if (code === "expired") {
    const label = labelFromKey(first(params.label));
    return { code, isError, text: label === null ? NOTICE_TEXT.expired : `${NOTICE_TEXT.expired}: ${label}` };
  }
  if (code === "ladder_checked") {
    const raw = first(params.n);
    const n = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number(raw) : null;
    if (n === null) return { code, isError, text: NOTICE_TEXT.ladder_checked };
    const text =
      n === 0 ? "Ladder checked. No new drafts." : `Ladder checked. ${n} new ${n === 1 ? "draft" : "drafts"}.`;
    return { code, isError, text };
  }
  return { code, isError, text: NOTICE_TEXT[code] };
}
