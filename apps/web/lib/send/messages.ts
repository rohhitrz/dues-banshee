import type { SendOutcome } from "@dues-banshee/agent";
import { STEP_TEXT, WAIT_TEXT } from "../graveyard/labels";
import { formatDisplayDate } from "../graveyard/today";

export interface OutcomeMessage {
  text: string;
  role: "status" | "alert";
}

const SANDBOX_TAIL = ", or use Open in WhatsApp.";
const SANDBOX_HEAD = "This number hasn't joined the WhatsApp sandbox in the last 3 days, or its 24-hour window has closed. ";

/** The Req 1.3 text. A missing or blank join code never leaves a placeholder or an empty `join` command. */
function sandboxText(sandboxJoinCode: string | undefined): string {
  const code = sandboxJoinCode?.trim() ?? "";
  const ask =
    code === ""
      ? "Ask the buyer to send the join code from the Twilio sandbox page to the sandbox number"
      : `Ask the buyer to send join ${code} to the sandbox number`;
  return `${SANDBOX_HEAD}${ask}${SANDBOX_TAIL}`;
}

/**
 * The one fixed message an Invoice_Panel shows for a send outcome (Req 4.6). Pure. Provider error texts never
 * reach it: `channel_failed` is mapped by its kind only (Req 8.2).
 */
export function outcomeMessage(outcome: SendOutcome, sandboxJoinCode: string | undefined): OutcomeMessage {
  switch (outcome.kind) {
    case "sent":
      return { text: "Queued with Twilio. Delivery is not tracked.", role: "status" };
    case "handed_off":
      return { text: "Opened in WhatsApp. Tap Send on your phone.", role: "status" };
    case "not_found":
      return { text: "Draft not found", role: "alert" };
    case "cannot_send":
      return { text: "This draft can't be sent", role: "alert" };
    case "approved_on":
      return {
        text: `This draft was approved on ${formatDisplayDate(outcome.approvalDay)}. Approve a fresh draft to send today.`,
        role: "alert",
      };
    case "send_check_failed": {
      const d = outcome.decision;
      const reason = d.action === "wait" ? WAIT_TEXT[d.reason] : STEP_TEXT[d.step];
      return { text: `Not sent: ${reason}`, role: "alert" };
    }
    case "payments_not_configured":
      return { text: "Payments are not configured", role: "alert" };
    case "pay_link_failed":
      return { text: "The payment link could not be created. Try again.", role: "alert" };
    case "no_buyer_number":
      return { text: "No WhatsApp number for this buyer", role: "alert" };
    case "sender_not_configured":
      return { text: "WhatsApp sender not configured", role: "alert" };
    case "too_long":
      return { text: "Message too long for WhatsApp (max 1,600 characters)", role: "alert" };
    case "channel_failed":
      return outcome.errorKind === "sandbox_window"
        ? { text: sandboxText(sandboxJoinCode), role: "alert" }
        : { text: "The message was not sent. Try again or use Open in WhatsApp.", role: "alert" };
    case "record_failed":
      return { text: "The message was queued but could not be recorded.", role: "alert" };
  }
}
