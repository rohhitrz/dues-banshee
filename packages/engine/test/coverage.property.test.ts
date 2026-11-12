import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, compareDates } from "../src/calendar-date";
import { RULE_IDS, dueDate, nextEscalationStep, statutoryInterest, taxBomb } from "../src/index";
import type {
  BankRate,
  CalendarDate,
  EscalationHistory,
  Invoice,
  LadderConfig,
  NonCoverageReason,
  SupplierActivity,
  SupplierCategory,
} from "../src/types";
import {
  arbBankRate,
  arbCoveredInvoice,
  arbHistory,
  arbLadderConfig,
  arbNonCoveredInvoice,
  arbToday,
} from "./arbitraries";

/**
 * Every non-covered classification: medium or unregistered in any activity (trading included,
 * which exercises the precedence of `medium_or_unregistered`), and micro/small traders.
 */
const NON_COVERED_CLASSIFICATIONS: readonly (readonly [SupplierCategory, SupplierActivity])[] = [
  ["medium", "manufacturing"],
  ["medium", "services"],
  ["medium", "trading"],
  ["unregistered", "manufacturing"],
  ["unregistered", "services"],
  ["unregistered", "trading"],
  ["micro", "trading"],
  ["small", "trading"],
];

interface Scenario {
  invoice: Invoice;
  today: CalendarDate;
  bankRate: BankRate;
  history: EscalationHistory;
  config: LadderConfig;
}

/** A non-covered invoice with each classification in turn, plus any bank rate, history, config and `today`. */
const arbScenario: fc.Arbitrary<Scenario> = fc
  .tuple(arbNonCoveredInvoice, fc.constantFrom(...NON_COVERED_CLASSIFICATIONS))
  .map(([base, [supplierCategory, supplierActivity]]): Invoice => ({ ...base, supplierCategory, supplierActivity }))
  .chain((invoice) =>
    fc
      .tuple(arbToday(invoice), arbBankRate, arbHistory(invoice), arbLadderConfig)
      .map(([today, bankRate, history, config]) => ({ invoice, today, bankRate, history, config })),
  );

/** Independent oracle for the Non_Coverage_Reason; `medium_or_unregistered` takes precedence over `trader`. */
function expectedReason(invoice: Invoice): NonCoverageReason {
  return invoice.supplierCategory === "medium" || invoice.supplierCategory === "unregistered"
    ? "medium_or_unregistered"
    : "trader";
}

function isPaidOn(invoice: Invoice, today: CalendarDate): boolean {
  return invoice.paidOn !== undefined && compareDates(invoice.paidOn, today) <= 0;
}

/** Checks Property 4 for one scenario. Strict equality also rules out stray keys such as `dueDate` or `taxBombDate`. */
function checkNonCovered({ invoice, today, bankRate, history, config }: Scenario): void {
  const reason = expectedReason(invoice);
  const base = { applicable: false, reason, ruleIds: ["MSMED-SCOPE"] };

  expect(dueDate(invoice)).toStrictEqual(base);
  expect(statutoryInterest(invoice, today, bankRate)).toStrictEqual({ ...base, interestPaise: 0 });
  expect(taxBomb(invoice, today)).toStrictEqual({ ...base, status: "not_applicable", deductionAtRiskPaise: 0 });

  // `paid` is checked before coverage (Requirement 6.15 precedence), and cites no rule.
  const decision = nextEscalationStep(invoice, history, today, config);
  expect(decision.action).toBe("wait");
  if (isPaidOn(invoice, today)) {
    expect(decision).toStrictEqual({ action: "wait", applicable: false, reason: "paid", ruleIds: [] });
  } else {
    expect(decision).toStrictEqual({ ...base, action: "wait" });
  }
}

describe("coverage properties", () => {
  // Feature: legal-engine, Property 4: Non-covered invoices get only MSMED-SCOPE
  it("Property 4: Non-covered invoices get only MSMED-SCOPE", () => {
    // **Validates: Requirements 3.8, 4.6, 5.6, 6.2, 8.3, 8.4, 8.7**
    fc.assert(fc.property(arbScenario, checkNonCovered));
  });

  // Feature: legal-engine, Property 4: Non-covered invoices get only MSMED-SCOPE
  it("Property 4: unpaid non-covered invoices wait with the coverage reason and never reach odr_pack", () => {
    // **Validates: Requirements 3.8, 4.6, 5.6, 6.2, 8.3, 8.4, 8.7**
    const arbUnpaid = arbScenario.map((scenario): Scenario => {
      const { paidOn: _ignored, ...rest } = scenario.invoice;
      void _ignored;
      return { ...scenario, invoice: rest };
    });
    fc.assert(
      fc.property(arbUnpaid, (scenario) => {
        checkNonCovered(scenario);
        const { invoice, history, today, config } = scenario;
        const decision = nextEscalationStep(invoice, history, today, config);
        expect(decision).toStrictEqual({
          action: "wait",
          applicable: false,
          reason: expectedReason(invoice),
          ruleIds: ["MSMED-SCOPE"],
        });
        expect("step" in decision).toBe(false);
      }),
    );
  });

  // Feature: legal-engine, Property 4: Non-covered invoices get only MSMED-SCOPE
  it("Property 4: a medium or unregistered trader gets medium_or_unregistered, not trader", () => {
    // **Validates: Requirements 8.4**
    fc.assert(
      fc.property(
        arbScenario.map(({ invoice, ...rest }): Scenario => ({
          ...rest,
          invoice: { ...invoice, supplierActivity: "trading" },
        })),
        (scenario) => {
          const { invoice } = scenario;
          const result = dueDate(invoice);
          expect(result.applicable).toBe(false);
          if (result.applicable) return;
          expect(result.reason).toBe(
            invoice.supplierCategory === "medium" || invoice.supplierCategory === "unregistered"
              ? "medium_or_unregistered"
              : "trader",
          );
        },
      ),
    );
  });
});

/**
 * Days from `acceptedOn` to `udyamRegisteredOn`, or `undefined` for no registration date.
 * Heavily biased to -1, 0 and +1, the cases either side of the caveat boundary.
 */
const arbRegistrationOffset: fc.Arbitrary<number | undefined> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(-1, 0, 1) },
  { weight: 2, arbitrary: fc.integer({ min: -400, max: 400 }) },
  { weight: 2, arbitrary: fc.constant(undefined) },
);

interface RegistrationScenario extends Scenario {
  offset: number | undefined;
  /** The same invoice with `udyamRegisteredOn` removed: the caveat-free reference. */
  withoutRegistration: Invoice;
}

const arbRegistrationScenario: fc.Arbitrary<RegistrationScenario> = fc
  .tuple(arbCoveredInvoice, arbRegistrationOffset)
  .chain(([base, offset]) => {
    const { udyamRegisteredOn: _ignored, ...withoutRegistration } = base;
    void _ignored;
    const invoice: Invoice =
      offset === undefined ? withoutRegistration : { ...withoutRegistration, udyamRegisteredOn: addDays(base.acceptedOn, offset) };
    return fc
      .tuple(arbToday(invoice), arbBankRate, arbHistory(invoice), arbLadderConfig)
      .map(([today, bankRate, history, config]) => ({
        invoice,
        today,
        bankRate,
        history,
        config,
        offset,
        withoutRegistration,
      }));
  });

/** All four invoice results for one scenario, in a fixed order. */
function allResults(
  invoice: Invoice,
  { today, bankRate, history, config }: Scenario,
): { name: string; result: { applicable: boolean; ruleIds: readonly string[]; caveat?: string } }[] {
  return [
    { name: "dueDate", result: dueDate(invoice) },
    { name: "statutoryInterest", result: statutoryInterest(invoice, today, bankRate) },
    { name: "taxBomb", result: taxBomb(invoice, today) },
    { name: "nextEscalationStep", result: nextEscalationStep(invoice, history, today, config) },
  ];
}

describe("registered-after-supply caveat properties", () => {
  // Feature: legal-engine, Property 5: Registered-after-supply caveat
  it("Property 5: late registration keeps the invoice covered and adds the caveat and MSMED-SCOPE", () => {
    // **Validates: Requirements 8.5, 8.6**
    fc.assert(
      fc.property(arbRegistrationScenario, (scenario) => {
        const { invoice, offset, withoutRegistration } = scenario;
        const actual = allResults(invoice, scenario);
        const reference = allResults(withoutRegistration, scenario);

        actual.forEach(({ name, result }, i) => {
          const base = reference[i]?.result;
          expect(base, name).toBeDefined();
          if (base === undefined) return;

          // The reference has no registration date, so it is covered and cites no MSMED-SCOPE.
          expect(base.applicable, name).toBe(true);
          expect(base.ruleIds, name).not.toContain("MSMED-SCOPE");
          expect("caveat" in base, name).toBe(false);

          // Every covered result stays applicable.
          expect(result.applicable, name).toBe(true);

          if (offset !== undefined && offset > 0) {
            // Same result as the reference, plus the caveat and MSMED-SCOPE among its other rule IDs.
            const expectedRuleIds = RULE_IDS.filter((id) => base.ruleIds.includes(id) || id === "MSMED-SCOPE");
            expect(result, name).toStrictEqual({
              ...base,
              caveat: "registered_after_supply",
              ruleIds: expectedRuleIds,
            });
            for (const id of base.ruleIds) expect(result.ruleIds, name).toContain(id);
          } else {
            // Registered on or before acceptance, or no date: no caveat and no MSMED-SCOPE.
            expect(result, name).toStrictEqual(base);
            expect("caveat" in result, name).toBe(false);
            expect(result.ruleIds, name).not.toContain("MSMED-SCOPE");
          }
        });
      }),
    );
  });

  // Feature: legal-engine, Property 5: Registered-after-supply caveat
  it("Property 5: the boundary offsets -1, 0 and +1 split at registration after acceptance", () => {
    // **Validates: Requirements 8.5, 8.6**
    fc.assert(
      fc.property(
        arbRegistrationScenario.filter(({ offset }) => offset !== undefined && Math.abs(offset) <= 1),
        (scenario) => {
          const { invoice, offset } = scenario;
          const expectCaveat = offset === 1;
          for (const { name, result } of allResults(invoice, scenario)) {
            expect(result.caveat, name).toBe(expectCaveat ? "registered_after_supply" : undefined);
            expect(result.ruleIds.includes("MSMED-SCOPE"), name).toBe(expectCaveat);
          }
        },
      ),
    );
  });
});
