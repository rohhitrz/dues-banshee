// Validates: Requirements 5.7, 5.8, 11.2, 11.11
import type { BankRate, Invoice } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { buildInvoiceFacts, checkPromiseAmount } from "../src/invoice-facts";

// Demo_Seed: Sharma Traders, invoice LPC/26-27/0412, accepted 2026-09-02, 45-day term, Demo_Supplier is
// a micro manufacturer registered 2024-04-15. Bank rate 5.75% (575 bps) effective 2026-10-07.
const SHARMA_INVOICE: Invoice = {
  id: "inv-sharma",
  amountPaise: 41_200_000,
  acceptedOn: "2026-09-02",
  agreedTermDays: 45,
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
  udyamRegisteredOn: "2024-04-15",
};
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

function facts(bankRate: BankRate | null) {
  return buildInvoiceFacts({
    invoice: SHARMA_INVOICE,
    bankRate,
    callToday: "2026-11-12",
    buyerName: "Sharma Traders",
    supplierName: "Laxmi Precision Components (Demo)",
    invoiceNumber: "LPC/26-27/0412",
  });
}

describe("buildInvoiceFacts for Sharma Traders at 2026-11-12", () => {
  it("returns the exact facts and total due", () => {
    expect(facts(BANK_RATE)).toEqual({
      ok: true,
      totalDuePaise: 41_712_794,
      facts: {
        buyer_name: "Sharma Traders",
        supplier_name: "Laxmi Precision Components (Demo)",
        invoice_number: "LPC/26-27/0412",
        principal_words: "four lakh twelve thousand rupees",
        due_date: "17 Oct 2026",
        due_rule_ids: ["MSMED-15"],
        days_overdue: 26,
        interest_words: "five thousand one hundred twenty-seven rupees and ninety-four paise",
        interest_rule_ids: ["MSMED-16"],
        total_due_words: "four lakh seventeen thousand one hundred twenty-seven rupees and ninety-four paise",
        total_due_paise: 41_712_794,
        tax_bomb_date: "31 Mar 2027",
        tax_bomb_days_left: 139,
        tax_bomb_rule_ids: ["IT-43BH"],
      },
    });
  });

  it("without a bank rate returns bank_rate_missing and no interest or total due", () => {
    const result = facts(null);
    expect(result).toEqual({
      ok: false,
      error: "bank_rate_missing",
      facts: {
        buyer_name: "Sharma Traders",
        supplier_name: "Laxmi Precision Components (Demo)",
        invoice_number: "LPC/26-27/0412",
        principal_words: "four lakh twelve thousand rupees",
        due_date: "17 Oct 2026",
        due_rule_ids: ["MSMED-15"],
        days_overdue: 26,
        tax_bomb_date: "31 Mar 2027",
        tax_bomb_days_left: 139,
        tax_bomb_rule_ids: ["IT-43BH"],
      },
    });
    expect(result.facts).not.toHaveProperty("interest_words");
    expect(result.facts).not.toHaveProperty("total_due_words");
    expect(result.facts).not.toHaveProperty("total_due_paise");
    expect(result).not.toHaveProperty("totalDuePaise");
  });

  it("throws for an invoice the rules do not cover", () => {
    expect(() =>
      buildInvoiceFacts({
        invoice: { ...SHARMA_INVOICE, supplierActivity: "trading" },
        bankRate: BANK_RATE,
        callToday: "2026-11-12",
        buyerName: "Sharma Traders",
        supplierName: "S",
        invoiceNumber: "N",
      }),
    ).toThrow();
  });
});

describe("checkPromiseAmount against the Sharma total due 41712794", () => {
  const TOTAL = 41_712_794;
  it("accepts the full total as not partial", () => {
    expect(checkPromiseAmount(41_712_794, TOTAL)).toEqual({ ok: true, isPartial: false });
  });
  it("accepts a smaller amount as partial", () => {
    expect(checkPromiseAmount(20_000_000, TOTAL)).toEqual({ ok: true, isPartial: true });
    expect(checkPromiseAmount(1, TOTAL)).toEqual({ ok: true, isPartial: true });
  });
  it("rejects zero, negative, above the total and non-integers", () => {
    for (const bad of [0, -1, 41_712_795, 1.5, Number.NaN]) {
      expect(checkPromiseAmount(bad, TOTAL)).toEqual({ ok: false });
    }
  });
});
