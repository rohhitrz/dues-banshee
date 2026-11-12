import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, dayDifference } from "../src/calendar-date";
import { dueDate } from "../src/index";
import type { DueDateResult, Invoice } from "../src/types";
import { arbCoveredInvoice } from "./arbitraries";

/** Independent oracle for MSMED-15: the agreed term capped at 45 days, or 15 days with no term. */
function expectedTermDays(invoice: Invoice): number {
  return invoice.agreedTermDays === undefined ? 15 : Math.min(invoice.agreedTermDays, 45);
}

/** Checks Property 3 for one invoice. Narrows `applicable` before reading `dueDate`. */
function checkDueDate(invoice: Invoice): void {
  const result: DueDateResult = dueDate(invoice);
  expect(result.applicable).toBe(true);
  if (!result.applicable) return;

  const difference = dayDifference(invoice.acceptedOn, result.dueDate);
  expect(difference).toBe(expectedTermDays(invoice));
  expect(difference).toBeGreaterThanOrEqual(1);
  expect(difference).toBeLessThanOrEqual(45);
  expect(result.ruleIds).toContain("MSMED-15");

  // MSMED-SCOPE and the caveat appear together, only when registered after the supply.
  const lateRegistration =
    invoice.udyamRegisteredOn !== undefined && dayDifference(invoice.acceptedOn, invoice.udyamRegisteredOn) > 0;
  if (lateRegistration) {
    expect(result.ruleIds).toContain("MSMED-SCOPE");
    expect(result.caveat).toBe("registered_after_supply");
  } else {
    expect(result.ruleIds).not.toContain("MSMED-SCOPE");
    expect(result.caveat).toBeUndefined();
  }
}

describe("due-date properties", () => {
  // Feature: legal-engine, Property 3: Due date follows MSMED-15
  it("Property 3: Due date follows MSMED-15", () => {
    // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 8.2**
    fc.assert(fc.property(arbCoveredInvoice, checkDueDate));
  });

  // Feature: legal-engine, Property 3: Due date follows MSMED-15
  it("Property 3: holds for invoices with no agreed term (15-day default)", () => {
    // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 8.2**
    fc.assert(
      fc.property(
        arbCoveredInvoice.filter((invoice) => invoice.agreedTermDays === undefined),
        (invoice) => {
          checkDueDate(invoice);
          const result = dueDate(invoice);
          if (result.applicable) expect(dayDifference(invoice.acceptedOn, result.dueDate)).toBe(15);
        },
      ),
    );
  });

  // Feature: legal-engine, Property 3: Due date follows MSMED-15
  it("Property 3: holds for terms longer than 45 days (capped at 45)", () => {
    // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 8.2**
    fc.assert(
      fc.property(
        arbCoveredInvoice.filter((invoice) => invoice.agreedTermDays !== undefined && invoice.agreedTermDays > 45),
        (invoice) => {
          checkDueDate(invoice);
          const result = dueDate(invoice);
          if (result.applicable) expect(dayDifference(invoice.acceptedOn, result.dueDate)).toBe(45);
        },
      ),
    );
  });

  // Feature: legal-engine, Property 3: Due date follows MSMED-15
  it("Property 3: holds around the registration boundary (-1, 0, +1 days, wider, absent)", () => {
    // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 8.2, 8.5, 8.6**
    const offsets = fc.oneof(
      fc.constantFrom<number | undefined>(-1, 0, 1, undefined),
      fc.integer({ min: -400, max: 400 }),
    );
    fc.assert(
      fc.property(arbCoveredInvoice, offsets, (base, offset) => {
        const { udyamRegisteredOn: _ignored, ...rest } = base;
        void _ignored;
        const invoice: Invoice = { ...rest };
        if (offset !== undefined) invoice.udyamRegisteredOn = addDays(base.acceptedOn, offset);
        checkDueDate(invoice);
      }),
    );
  });
});
