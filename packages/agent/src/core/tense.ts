import type { CitationResult } from "./citations";
import { normalise } from "./match";

/**
 * Patterns for a future or present "is due" claim about the due date. Each is anchored on
 * the literal `{{due_date}}` token, so past forms ("ko due tha", "due ho chuka hai",
 * "was due on {{due_date}}") and amount sentences ("{{principal}} abhi bhi due hai") never
 * match. They run on `normalise(text)` (lowercase, single spaces). Built once, non-global,
 * so no `lastIndex` state is shared between calls.
 */
export const FUTURE_TENSE_PATTERNS: readonly RegExp[] = [
  // H1: "{{due_date}} ko due hai"
  /\{\{due_date\}\} (?:ko|tak) due (?:hai|hoga|hogi|ho jayega)(?![\p{L}])/iu,
  // H2: "{{due_date}} tak payment karna hai"
  /\{\{due_date\}\} (?:ko|tak) (?:payment|bhugtan) (?:karna hai|karna hoga|dena hai|hoga|due hai|due ho jayega)(?![\p{L}])/iu,
  // E1: "is due on {{due_date}}", "becomes due on or before {{due_date}}", "is due for payment on {{due_date}}"
  /(?:is|are|will be|falls|fall|becomes|become) due (?:for payment )?(?:on or before|on|by) \{\{due_date\}\}/iu,
  // E2: "is payable by {{due_date}}", "is payable on or before {{due_date}}"
  /(?:is|are|will be) payable (?:on or before|on|by) \{\{due_date\}\}/iu,
  // E3: "pay {{principal}} by {{due_date}}" (one sentence; also "kindly pay", "clear", "settle")
  /\b(?:pay|clear|settle)\b[^.!?]*?\b(?:by|before|on or before) \{\{due_date\}\}/iu,
  // H3: "{{due_date}} tak bhugtan kar dein"
  /\{\{due_date\}\} (?:tak|se pehle) (?:bhugtan|payment) kar(?:ein| ?dein| ?dijiye|na hoga)(?![\p{L}])/iu,
];

/**
 * Blocks a draft that talks about the due date in the future or present tense when the
 * invoice is overdue. Returns null (pass) when not overdue or when no pattern matches.
 * `overdue` is decided by the caller; this file does no date maths.
 */
export function tenseCheck(text: string, overdue: boolean): CitationResult | null {
  if (!overdue) return null;
  const normalised = normalise(text);
  for (const pattern of FUTURE_TENSE_PATTERNS) {
    const match = pattern.exec(normalised);
    if (match !== null) return { ok: false, reason: "overdue_tense", offending: match[0] };
  }
  return null;
}
