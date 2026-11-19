import { RULE_IDS } from "@dues-banshee/engine";
import type { BlockReason } from "../core/citations";
import { guardDraft } from "../core/draft-guard";
import type { Fixture } from "./fixture";

export type EvalOutcome = "accept" | BlockReason;

export interface EvalResult {
  name: string;
  expected: EvalOutcome;
  actual: EvalOutcome;
  pass: boolean;
}

/** Runs the Draft_Guard on every fixture. Pure: no network, no LLM. */
export function runEvals(fixtures: readonly Fixture[]): EvalResult[] {
  return fixtures.map(({ name, context, output, expected }) => {
    const result = guardDraft(output, {
      step: context.step,
      allowed: context.allowed,
      bankRateExists: context.bankRateExists,
      overdue: context.overdue,
      ruleIds: RULE_IDS,
    });
    const actual: EvalOutcome = result.ok ? "accept" : result.reason;
    return { name, expected, actual, pass: actual === expected };
  });
}

/** One `PASS|FAIL <name>  expected=<e>  actual=<a>` line per result, then `<passed>/<total> passed`. */
export function formatReport(results: readonly EvalResult[]): string {
  const lines = results.map(
    (r) => `${r.pass ? "PASS" : "FAIL"} ${r.name}  expected=${r.expected}  actual=${r.actual}`,
  );
  const passed = results.filter((r) => r.pass).length;
  lines.push(`${passed}/${results.length} passed`);
  return lines.join("\n");
}
