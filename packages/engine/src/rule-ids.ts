export const RULE_IDS = [
  "MSMED-15",
  "MSMED-16",
  "MSMED-18",
  "IT-43BH",
  "MSMED-SCOPE",
  "MSMED-ODR",
] as const;

export type RuleId = (typeof RULE_IDS)[number];
