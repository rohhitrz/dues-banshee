import { RULE_SOURCES } from "@dues-banshee/engine";
import type { RuleId } from "@dues-banshee/engine";

/** Footer text on every outbound document. Equals `FOOTER_TEXT` in `apps/web/components/app-shell.tsx`. */
export const DISCLAIMER = "Reminders a supplier sends to its own buyers. Not legal advice.";

/** `Basis: ID (source); ID (source)`, in the order given. */
export function basisLine(ruleIds: readonly RuleId[]): string {
  return "Basis: " + ruleIds.map((id) => `${id} (${RULE_SOURCES[id]})`).join("; ");
}

/** The body, a blank line, the Basis_Line, then the Disclaimer on its own line. */
export function buildFinalText(body: string, ruleIds: readonly RuleId[]): string {
  return `${body}\n\n${basisLine(ruleIds)}\n${DISCLAIMER}`;
}
