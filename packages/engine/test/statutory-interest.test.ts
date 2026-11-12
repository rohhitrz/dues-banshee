import { describe, expect, it } from "vitest";
import { addDays } from "../src/calendar-date";
import { MAX_PAISE, statutoryInterest, ValidationError } from "../src/index";
import type { InterestResult, Invoice } from "../src/types";
import { bankRate575, sharmaTradersInvoice } from "./fixtures";

/** Sharma Traders due date: 2026-09-02 + 45 days. */
const SHARMA_DUE = "2026-10-17";

function invoiceWith(overrides: Partial<Invoice>): Invoice {
  return { ...sharmaTradersInvoice, ...overrides };
}

/** Narrows to the covered result, failing the test if the invoice is not covered. */
function covered(result: InterestResult): Extract<InterestResult, { applicable: true }> {
  if (!result.applicable) {
    throw new Error(`expected a covered invoice, got reason ${result.reason}`);
  }
  return result;
}

describe("statutoryInterest", () => {
  it("gives Sharma Traders 26 accrual days and ₹5,127.94 on 2026-11-12 at 575 bps", () => {
    const result = covered(statutoryInterest(sharmaTradersInvoice, "2026-11-12", bankRate575));
    expect(result.accrualDays).toBe(26);
    expect(result.interestPaise).toBe(512_794);
    expect(result.statutoryRateBps).toBe(1725);
    expect(result.rateAsOf).toBe("2026-10-07");
    expect(result.ruleIds).toContain("MSMED-16");
  });

  it("counts the day after the due date as accrual day 1", () => {
    const result = covered(statutoryInterest(sharmaTradersInvoice, "2026-10-18", bankRate575));
    expect(result.accrualDays).toBe(1);
    expect(result.interestPaise).toBeGreaterThan(0);
  });

  it("charges no interest on the due date itself", () => {
    const result = covered(statutoryInterest(sharmaTradersInvoice, SHARMA_DUE, bankRate575));
    expect(result.accrualDays).toBe(0);
    expect(result.interestPaise).toBe(0);
  });

  it("charges exactly one monthly rest after 30 days (41,200,000 × 0.014375)", () => {
    const result = covered(statutoryInterest(sharmaTradersInvoice, "2026-11-16", bankRate575));
    expect(result.accrualDays).toBe(30);
    expect(result.interestPaise).toBe(592_250);
  });

  it("ends accrual on paidOn when it is before today", () => {
    const paid = invoiceWith({ paidOn: "2026-11-01" });
    const result = covered(statutoryInterest(paid, "2026-11-12", bankRate575));
    const atPayment = covered(statutoryInterest(sharmaTradersInvoice, "2026-11-01", bankRate575));
    expect(result.accrualDays).toBe(15);
    expect(result.interestPaise).toBe(atPayment.interestPaise);
  });

  it("returns a Non_Coverage_Result with zero interest for a trader", () => {
    const trader = invoiceWith({ supplierActivity: "trading" });
    const result = statutoryInterest(trader, "2026-11-12", bankRate575);
    expect(result).toEqual({
      applicable: false,
      reason: "trader",
      ruleIds: ["MSMED-SCOPE"],
      interestPaise: 0,
    });
  });

  it("throws a ValidationError on today when interest would exceed the safe integer range", () => {
    const huge = invoiceWith({ amountPaise: MAX_PAISE });
    const extremeRate = { annualBps: 5000, asOf: "2026-10-07" };
    // ~10 years past due: 3650 days is the float path, 3600 days (120 rests) is the BigInt path.
    for (const days of [3650, 3600]) {
      const today = addDays(SHARMA_DUE, days);
      let caught: unknown;
      try {
        statutoryInterest(huge, today, extremeRate);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).field).toBe("today");
    }
  });
});
