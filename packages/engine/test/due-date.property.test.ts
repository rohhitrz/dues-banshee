import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { dayDifference } from "../src/calendar-date";
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

  // MSMED-SCOPE appears only with the registered-after-supply caveat; MSMED-15 is always kept.
  if (invoice.udyamRegisteredOn !== undefined && dayDifference(invoice.acceptedOn, invoice.udyamRegisteredOn) > 0) {
    expect(result.ruleIds).toContain("MSMED-SCOPE");
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
  it("Property 3: holds when udyamRegisteredOn is present", () => {
    // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 8.2**
    fc.assert(
      fc.property(
        arbCoveredInvoice.filter((invoice) => invoice.udyamRegisteredOn !== undefined),
        checkDueDate,
      ),
    );
  });
});
