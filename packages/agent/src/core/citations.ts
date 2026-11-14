import type { RuleId } from "@dues-banshee/engine";
import type { ModelOutput } from "./model-output";

export const PLACEHOLDERS = [
  "buyer_name",
  "invoice_number",
  "principal",
  "due_date",
  "interest",
  "rate_as_of",
  "tax_bomb_date",
  "tax_bomb_days",
  "deduction_at_risk",
  "pay_link",
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

/** The rule a Placeholder's value depends on. Placeholders not listed need no citation. */
export const PLACEHOLDER_RULE: Partial<Record<Placeholder, RuleId>> = {
  due_date: "MSMED-15",
  interest: "MSMED-16",
  rate_as_of: "MSMED-16",
  tax_bomb_date: "IT-43BH",
  tax_bomb_days: "IT-43BH",
  deduction_at_risk: "IT-43BH",
};

export type BlockReason =
  | "missing_citation"
  | "invalid_rule_id"
  | "rule_not_applicable"
  | "unknown_placeholder"
  | "uncited_placeholder"
  | "bank_rate_missing"
  | "literal_figure"
  | "acceptance_rule_missing";

export type CitationResult =
  | { ok: true; ruleIds: RuleId[] }
  | { ok: false; reason: BlockReason; offending: string | null };

const PLACEHOLDER_SET: ReadonlySet<string> = new Set(PLACEHOLDERS);

// Non-global regexes only: they are used with `matchAll` (which clones them) or `exec`
// on a single call, so no `lastIndex` state is shared between calls.
const TOKEN = /\{\{([^{}]*)\}\}/g;
const LITERAL_FIGURE = /\p{Nd}|₹|\b(?:rs|inr)\b/iu;
const DELIVERY_TERM = /deliver|डिलीवर/i;

const blocked = (reason: BlockReason, offending: string | null): CitationResult => ({
  ok: false,
  reason,
  offending,
});

/**
 * Accepts or blocks a Model_Output. Pure: the checks run in a fixed order and the first
 * failure wins. It takes no buyer name or invoice number, so those fields cannot change
 * the result. `ruleIds` is the RULE_IDS list (a parameter so tests can vary it).
 */
export function validateCitations(
  out: ModelOutput,
  allowed: readonly RuleId[],
  ruleIds: readonly string[],
  bankRateExists: boolean,
): CitationResult {
  const cited = out.ruleIds;
  const allowedSet: ReadonlySet<string> = new Set(allowed);
  const knownSet: ReadonlySet<string> = new Set(ruleIds);
  const citedSet: ReadonlySet<string> = new Set(cited);

  // 1. At least one citation.
  if (cited.length === 0) return blocked("missing_citation", null);

  // 2. Every cited ID is a real rule ID.
  const invalid = cited.find((id) => !knownSet.has(id));
  if (invalid !== undefined) return blocked("invalid_rule_id", invalid);

  // 3. Every cited ID applies to this invoice.
  const notApplicable = cited.find((id) => !allowedSet.has(id));
  if (notApplicable !== undefined) return blocked("rule_not_applicable", notApplicable);

  const tokens = [...out.text.matchAll(TOKEN)].map((m) => ({ token: m[0], name: m[1] ?? "" }));

  // 4. Only known Placeholders.
  const unknown = tokens.find((t) => !PLACEHOLDER_SET.has(t.name));
  if (unknown !== undefined) return blocked("unknown_placeholder", unknown.token);

  // 5. A Placeholder that carries a legal figure needs its rule cited.
  for (const t of tokens) {
    const rule = PLACEHOLDER_RULE[t.name as Placeholder];
    if (rule !== undefined && !citedSet.has(rule)) return blocked("uncited_placeholder", t.token);
  }

  // 6. No interest figures without a Bank_Rate.
  if (!bankRateExists) {
    const rateToken = tokens.find((t) => t.name === "interest" || t.name === "rate_as_of");
    if (rateToken !== undefined) return blocked("bank_rate_missing", rateToken.token);
  }

  // 7. No literal figures: digits (any script), ₹, "Rs", "INR" outside Placeholders.
  const stripped = out.text.replace(TOKEN, "");
  const figure = LITERAL_FIGURE.exec(stripped);
  if (figure !== null) return blocked("literal_figure", figure[0]);

  // 8. Any mention of delivery needs MSMED-2B, both known and cited.
  const delivery = DELIVERY_TERM.exec(out.text);
  if (delivery !== null && (!knownSet.has("MSMED-2B") || !citedSet.has("MSMED-2B"))) {
    return blocked("acceptance_rule_missing", delivery[0]);
  }

  // Accepted: every entry passed checks 2–3, so each is an allowed RuleId.
  return { ok: true, ruleIds: [...new Set(cited)] as RuleId[] };
}
