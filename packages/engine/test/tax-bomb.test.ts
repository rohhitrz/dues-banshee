import { describe, expect, it } from "vitest";
import { taxBomb } from "../src/index";
import type { Invoice } from "../src/types";
import { sharmaTradersInvoice } from "./fixtures";

const A = sharmaTradersInvoice.amountPaise;

function invoiceWith(overrides: Partial<Invoice>): Invoice {
  return { ...sharmaTradersInvoice, ...overrides };
}

describe("taxBomb", () => {
  it("arms the bomb for Sharma Traders on 2026-11-12 with 139 days left", () => {
    expect(taxBomb(sharmaTradersInvoice, "2026-11-12")).toStrictEqual({
      applicable: true,
      status: "armed",
      taxBombDate: "2027-03-31",
      deductionDeadline: "2027-03-31",
      daysLeft: 139,
      deductionAtRiskPaise: 41_200_000,
      ruleIds: ["IT-43BH"],
    });
  });

  it("uses the due date as the deadline when it falls after 31 March", () => {
    const invoice = invoiceWith({ acceptedOn: "2027-03-10", agreedTermDays: 45 });
    expect(taxBomb(invoice, "2027-03-20")).toStrictEqual({
      applicable: true,
      status: "armed",
      taxBombDate: "2027-03-31",
      deductionDeadline: "2027-04-24",
      daysLeft: 35,
      deductionAtRiskPaise: A,
      ruleIds: ["IT-43BH"],
    });
  });

  it("explodes when paid after the deduction deadline", () => {
    const invoice = invoiceWith({ paidOn: "2027-04-05" });
    expect(taxBomb(invoice, "2027-04-10")).toMatchObject({
      applicable: true,
      status: "exploded",
      deductionDeadline: "2027-03-31",
      daysLeft: 0,
      deductionAtRiskPaise: A,
    });
  });

  it("defuses when paid before the deduction deadline", () => {
    const invoice = invoiceWith({ paidOn: "2027-01-15" });
    expect(taxBomb(invoice, "2027-02-01")).toMatchObject({
      applicable: true,
      status: "defused",
      daysLeft: 0,
      deductionAtRiskPaise: 0,
      ruleIds: ["IT-43BH"],
    });
  });

  it("explodes an unpaid invoice the day after the deadline", () => {
    expect(taxBomb(sharmaTradersInvoice, "2027-04-01")).toMatchObject({
      applicable: true,
      status: "exploded",
      daysLeft: 0,
      deductionAtRiskPaise: A,
    });
  });

  it("treats a payment dated after today as still unpaid", () => {
    const invoice = invoiceWith({ paidOn: "2027-01-15" });
    expect(taxBomb(invoice, "2026-11-12")).toMatchObject({
      status: "armed",
      daysLeft: 139,
      deductionAtRiskPaise: A,
    });
  });

  it.each([
    ["trader", invoiceWith({ supplierActivity: "trading" })],
    ["medium", invoiceWith({ supplierCategory: "medium" })],
  ])("returns not_applicable with only MSMED-SCOPE for a non-covered %s invoice", (_label, invoice) => {
    const result = taxBomb(invoice, "2026-11-12");
    expect(result.applicable).toBe(false);
    expect(result.status).toBe("not_applicable");
    expect(result.deductionAtRiskPaise).toBe(0);
    expect(result.ruleIds).toStrictEqual(["MSMED-SCOPE"]);
    expect(result).not.toHaveProperty("taxBombDate");
    expect(result).not.toHaveProperty("deductionDeadline");
    expect(result).not.toHaveProperty("daysLeft");
  });

  it("keeps the invoice covered and adds the caveat when registered after supply", () => {
    const invoice = invoiceWith({ udyamRegisteredOn: "2026-10-01" });
    expect(taxBomb(invoice, "2026-11-12")).toMatchObject({
      applicable: true,
      status: "armed",
      caveat: "registered_after_supply",
      ruleIds: ["IT-43BH", "MSMED-SCOPE"],
    });
  });
});
