import { formatINR } from "@dues-banshee/engine";
import type { Paise, RuleId } from "@dues-banshee/engine";
import { buildFinalText } from "../core/final-text";
import { PAY_LINK_TEXT } from "../core/fact-sheet";

/** `Pay ₹4,12,000.00 here: <url>`. The amount is formatted by the Engine, never by the model. */
export function payLinkLine(amountPaise: Paise, url: string): string {
  return `Pay ${formatINR(amountPaise, "full")} here: ${url}`;
}

export type OutboundTextResult = { ok: true; text: string } | { ok: false; reason: "multiple_markers" };

/**
 * The text sent to the buyer: the Draft's body with the Pay_Link_Marker replaced by the link URL only
 * (or, with no marker, the body, a blank line and the Pay_Link_Line), then the Basis_Line and the
 * Disclaimer as the last line (Req 3.6, 3.7).
 *
 * A body with two or more markers cannot hold exactly one link URL and keep every marker's sentence,
 * so it is refused. The body is split and joined instead of `String.replace`, because a replacement
 * string treats `$&` and `$'` as patterns and a URL may contain `$`.
 */
export function buildOutboundText(input: {
  body: string;
  ruleIds: readonly RuleId[];
  url: string;
  amountPaise: Paise;
}): OutboundTextResult {
  const parts = input.body.split(PAY_LINK_TEXT);
  if (parts.length > 2) return { ok: false, reason: "multiple_markers" };
  const withLink =
    parts.length === 2
      ? `${parts[0] ?? ""}${input.url}${parts[1] ?? ""}`
      : `${input.body}\n\n${payLinkLine(input.amountPaise, input.url)}`;
  return { ok: true, text: buildFinalText(withLink, input.ruleIds) };
}
