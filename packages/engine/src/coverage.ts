import { dayDifference } from "./calendar-date";
import { RULE_IDS } from "./rule-ids";
import type { RuleId } from "./rule-ids";
import type { Caveat, CoverageResult, Invoice, NonCoverageReason, NonCoverageResult } from "./types";
import { validateInvoice } from "./validate";

/** Non_Coverage_Result for MSMED-SCOPE: the only rule a non-covered invoice may cite. */
export function nonCoverageResult(reason: NonCoverageReason): NonCoverageResult {
  return { applicable: false, reason, ruleIds: ["MSMED-SCOPE"] };
}

/**
 * Whether MSMED s.15-18 and IT-43BH apply to the invoice (MSMED-SCOPE).
 * Category is checked first, so a medium trader is `medium_or_unregistered`.
 */
export function coverage(invoice: Invoice): CoverageResult {
  validateInvoice(invoice);
  if (invoice.supplierCategory === "medium" || invoice.supplierCategory === "unregistered") {
    return nonCoverageResult("medium_or_unregistered");
  }
  if (invoice.supplierActivity === "trading") {
    return nonCoverageResult("trader");
  }
  const registeredAfterSupply =
    invoice.udyamRegisteredOn !== undefined && dayDifference(invoice.acceptedOn, invoice.udyamRegisteredOn) > 0;
  return registeredAfterSupply
    ? { applicable: true, caveat: "registered_after_supply", ruleIds: ["MSMED-SCOPE"] }
    : { applicable: true, ruleIds: [] };
}

/** De-duplicates rule IDs and orders them as in `RULE_IDS`, so results are deterministic. */
export function normalizeRuleIds(ruleIds: readonly RuleId[]): RuleId[] {
  return RULE_IDS.filter((id) => ruleIds.includes(id));
}

/**
 * Returns `result` with its `ruleIds` normalized. When `cov` carries the
 * Registered_After_Supply_Caveat, also copies the caveat and adds MSMED-SCOPE.
 */
export function withCaveat<T extends { ruleIds: RuleId[]; caveat?: Caveat }>(
  result: T,
  cov: CoverageResult,
): T {
  if (cov.applicable && cov.caveat !== undefined) {
    return {
      ...result,
      caveat: cov.caveat,
      ruleIds: normalizeRuleIds([...result.ruleIds, "MSMED-SCOPE"]),
    };
  }
  return { ...result, ruleIds: normalizeRuleIds(result.ruleIds) };
}
