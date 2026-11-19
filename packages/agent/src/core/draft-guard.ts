import type { LadderStep, RuleId } from "@dues-banshee/engine";
import { validateCitations, type CitationResult } from "./citations";
import type { ModelOutput } from "./model-output";
import { tenseCheck } from "./tense";
import { toneCheck } from "./tone";

export interface GuardContext {
  step: LadderStep;
  allowed: readonly RuleId[];
  /** RULE_IDS in production (a parameter so tests and evals can vary it). */
  ruleIds: readonly string[];
  bankRateExists: boolean;
  overdue: boolean;
}

/**
 * Runs the citation check first, then the tone check, then the tense check. The first
 * failure wins; on success the citation result (with its `ruleIds`) is returned unchanged.
 * Pure: no I/O, no clock.
 */
export function guardDraft(out: ModelOutput, ctx: GuardContext): CitationResult {
  const c = validateCitations(out, ctx.allowed, ctx.ruleIds, ctx.bankRateExists);
  if (!c.ok) return c;
  return toneCheck(out.text, ctx.step) ?? tenseCheck(out.text, ctx.overdue) ?? c;
}
