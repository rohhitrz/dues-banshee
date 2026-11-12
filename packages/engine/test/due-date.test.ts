import { describe, expect, it } from "vitest";
import { dayDifference } from "../src/calendar-date";
import { dueDate } from "../src/index";
import type { Invoice } from "../src/types";
import { sharmaTradersInvoice } from "./fixtures";

/** Sharma Traders without any agreed term (the object is built, not destructured, so no key is left set to undefined). */
const noTermInvoice: Invoice = {
  id: sharmaTradersInvoice.id,
  amountPaise: sharmaTradersInvoice.amountPaise,
  acceptedOn: sharmaTradersInvoice.acceptedOn,
  supplierCategory: sharmaTradersInvoice.supplierCategory,
  supplierActivity: sharmaTradersInvoice.supplierActivity,
};

function invoiceWith(overrides: Partial<Invoice>): Invoice {
  return { ...sharmaTradersInvoice, ...overrides };
}

/** Returns the due date of a covered invoice, failing the test if the invoice is not covered. */
function coveredDueDate(invoice: Invoice): string {
  const result = dueDate(invoice);
  if (!result.applicable) {
    throw new Error(`expected a covered invoice, got reason ${result.reason}`);
  }
  return result.dueDate;
}

describe("dueDate", () => {
  it("gives Sharma Traders 2026-10-17 citing only MSMED-15", () => {
    expect(dueDate(sharmaTradersInvoice)).toStrictEqual({
      applicable: true,
      dueDate: "2026-10-17",
      ruleIds: ["MSMED-15"],
    });
  });

  it("caps an agreed term of 60 days at 45 days after acceptance", () => {
    const due = coveredDueDate(invoiceWith({ agreedTermDays: 60 }));
    expect(dayDifference(sharmaTradersInvoice.acceptedOn, due)).toBe(45);
    expect(due).toBe("2026-10-17");
  });

  it("keeps an agreed term below 45 days as agreed", () => {
    const due = coveredDueDate(invoiceWith({ agreedTermDays: 30 }));
    expect(dayDifference(sharmaTradersInvoice.acceptedOn, due)).toBe(30);
  });

  it("uses 15 days after acceptance when no term was agreed", () => {
    const result = dueDate(noTermInvoice);
    expect(result).toStrictEqual({ applicable: true, dueDate: "2026-09-17", ruleIds: ["MSMED-15"] });
    expect(dayDifference(noTermInvoice.acceptedOn, coveredDueDate(noTermInvoice))).toBe(15);
  });

  it("returns the Non_Coverage_Result for a medium trader, with reason medium_or_unregistered", () => {
    const result = dueDate(invoiceWith({ supplierCategory: "medium", supplierActivity: "trading" }));
    expect(result.applicable).toBe(false);
    expect(result).toStrictEqual({
      applicable: false,
      reason: "medium_or_unregistered",
      ruleIds: ["MSMED-SCOPE"],
    });
  });

  it("returns reason trader for a micro trader, citing only MSMED-SCOPE and giving no dueDate", () => {
    const result = dueDate(invoiceWith({ supplierCategory: "micro", supplierActivity: "trading" }));
    expect(result.applicable).toBe(false);
    expect(result).toMatchObject({ reason: "trader", ruleIds: ["MSMED-SCOPE"] });
    expect(result).not.toHaveProperty("dueDate");
  });

  it("returns reason medium_or_unregistered for an unregistered supplier, with no dueDate", () => {
    const result = dueDate(invoiceWith({ supplierCategory: "unregistered" }));
    expect(result).toStrictEqual({
      applicable: false,
      reason: "medium_or_unregistered",
      ruleIds: ["MSMED-SCOPE"],
    });
    expect(result).not.toHaveProperty("dueDate");
  });

  it("keeps the invoice covered when Udyam registration came after acceptance, and adds the caveat", () => {
    const result = dueDate(invoiceWith({ udyamRegisteredOn: "2026-09-03" }));
    expect(result).toStrictEqual({
      applicable: true,
      dueDate: "2026-10-17",
      caveat: "registered_after_supply",
      ruleIds: ["MSMED-15", "MSMED-SCOPE"],
    });
  });

  it.each(["2026-09-02", "2026-08-01"])("adds no caveat when Udyam registration is on or before acceptance (%s)", (registeredOn) => {
    const result = dueDate(invoiceWith({ udyamRegisteredOn: registeredOn }));
    expect(result).toStrictEqual({
      applicable: true,
      dueDate: "2026-10-17",
      ruleIds: ["MSMED-15"],
    });
    expect(result).not.toHaveProperty("caveat");
  });
});
