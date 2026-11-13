export const RULE_IDS = [
  "MSMED-15",
  "MSMED-16",
  "MSMED-18",
  "IT-43BH",
  "MSMED-SCOPE",
  "MSMED-ODR",
  "MSMED-2B",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Source column of `.kiro/steering/legal-rules.md`, keyed by rule ID. */
export const RULE_SOURCES: Readonly<Record<RuleId, string>> = Object.freeze({
  "MSMED-15": "MSMED Act 2006, s.15",
  "MSMED-16": "MSMED Act 2006, s.16",
  "MSMED-18": "MSMED Act 2006, s.18",
  "IT-43BH": "Income-tax Act 1961, s.43B(h); Income-tax Act 2025, s.37(2)(g)",
  "MSMED-SCOPE": "MSMED Act s.2(n); MoMSME OM 02.07.2021",
  "MSMED-ODR": "MoMSME",
  "MSMED-2B": "MSMED Act 2006, s.2(b) and Explanation",
});
