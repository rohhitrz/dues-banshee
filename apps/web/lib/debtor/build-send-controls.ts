import { buildOutboundText } from "@dues-banshee/agent";
import type { InvoiceSendState } from "@dues-banshee/db";
import { RULE_IDS, type CalendarDate, type Paise, type RuleId } from "@dues-banshee/engine";
import { formatDisplayDate } from "../graveyard/today";
import { pickSendableDraft, sendControlState, type ControlState } from "../send/control-state";

/** The preview shows this in place of the Pay_Link URL (Req 4.1). */
export const LINK_PLACEHOLDER = "<link created on send>";

/** Everything SendControls needs for one invoice. Plain data only: booleans, strings and dates, no secrets. */
export interface SendControlsData {
  invoiceId: string;
  state: ControlState;
  /** "Sent on <D MMM YYYY> via <Twilio sandbox | your WhatsApp>", or null (Req 4.7). */
  sentText: string | null;
  /** The Demo_Override, sent back as the hidden `today` field; null for every other supplier. */
  override: CalendarDate | null;
}

function toRuleIds(ids: readonly string[]): RuleId[] {
  return ids.filter((id): id is RuleId => (RULE_IDS as readonly string[]).includes(id));
}

export interface BuildSendControlsInput {
  state: InvoiceSendState;
  amountPaise: Paise;
  buyerNumberSet: boolean;
  twilioReady: boolean;
  override: CalendarDate | null;
}

/**
 * Chooses the Draft the controls act on, builds its Outbound_Text preview with the Pay_Link URL left as
 * "<link created on send>", and picks the control state. Pure.
 */
export function buildSendControls({
  state,
  amountPaise,
  buyerNumberSet,
  twilioReady,
  override,
}: BuildSendControlsInput): SendControlsData {
  const draft = pickSendableDraft(state.sendableDrafts);
  let preview: string | null = null;
  if (draft !== null) {
    const built = buildOutboundText({
      body: draft.bodyText,
      ruleIds: toRuleIds(draft.ruleIds),
      url: LINK_PLACEHOLDER,
      amountPaise,
    });
    // A body with two markers cannot be sent (Req 3.7); the send action refuses it, so no preview is shown.
    preview = built.ok ? built.text : null;
  }
  const sentText =
    state.lastSent === null
      ? null
      : `Sent on ${formatDisplayDate(state.lastSent.sentOn)} via ${
          state.lastSent.channel === "twilio_sandbox" ? "Twilio sandbox" : "your WhatsApp"
        }`;
  return {
    invoiceId: state.invoiceId,
    state: sendControlState({ draft, buyerNumberSet, twilioReady, preview }),
    sentText,
    override,
  };
}
