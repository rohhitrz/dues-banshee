import type { BankRate, Invoice } from "../src/types";

/**
 * The Sharma Traders invoice used across the spec: ₹4,12,000 accepted on 2026-09-02
 * with a 45-day agreed term, from a micro manufacturing supplier.
 * Due date 2026-10-17; Tax_Bomb_Date 2027-03-31.
 */
export const sharmaTradersInvoice: Invoice = {
  id: "sharma-traders",
  amountPaise: 41_200_000,
  acceptedOn: "2026-09-02",
  agreedTermDays: 45,
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
};

/** RBI bank rate 5.75% as of 2026-10-07, so the statutory rate is 17.25% p.a. */
export const bankRate575: BankRate = { annualBps: 575, asOf: "2026-10-07" };
