import { describe, expect, it } from "vitest";
import { coverage } from "../src/index";
import type { Invoice } from "../src/types";
import { sharmaTradersInvoice } from "./fixtures";

function invoiceWith(overrides: Partial<Invoice>): Invoice {
  return { ...sharmaTradersInvoice, ...overrides };
}

describe("coverage", () => {
  it("covers Sharma Traders with no rule IDs and no caveat", () => {
    const result = coverage(sharmaTradersInvoice);
    expect(result).toStrictEqual({ applicable: true, ruleIds: [] });
    expect(result).not.toHaveProperty("caveat");
  });

  it.each(["micro", "small"] as const)("covers a %s manufacturer", (supplierCategory) => {
    expect(coverage(invoiceWith({ supplierCategory }))).toStrictEqual({ applicable: true, ruleIds: [] });
  });

  it("covers a micro service provider", () => {
    expect(coverage(invoiceWith({ supplierActivity: "services" }))).toStrictEqual({
      applicable: true,
      ruleIds: [],
    });
  });

  it("excludes a medium manufacturer with reason medium_or_unregistered", () => {
    expect(coverage(invoiceWith({ supplierCategory: "medium" }))).toStrictEqual({
      applicable: false,
      reason: "medium_or_unregistered",
      ruleIds: ["MSMED-SCOPE"],
    });
  });

  it("excludes an unregistered supplier with reason medium_or_unregistered", () => {
    expect(coverage(invoiceWith({ supplierCategory: "unregistered" }))).toStrictEqual({
      applicable: false,
      reason: "medium_or_unregistered",
      ruleIds: ["MSMED-SCOPE"],
    });
  });

  it("excludes a micro trader with reason trader", () => {
    expect(coverage(invoiceWith({ supplierActivity: "trading" }))).toStrictEqual({
      applicable: false,
      reason: "trader",
      ruleIds: ["MSMED-SCOPE"],
    });
  });

  it("checks category first: a medium trader is medium_or_unregistered, not trader", () => {
    expect(coverage(invoiceWith({ supplierCategory: "medium", supplierActivity: "trading" }))).toMatchObject({
      applicable: false,
      reason: "medium_or_unregistered",
    });
  });

  it("checks category first: an unregistered trader is medium_or_unregistered", () => {
    expect(coverage(invoiceWith({ supplierCategory: "unregistered", supplierActivity: "trading" }))).toMatchObject({
      applicable: false,
      reason: "medium_or_unregistered",
    });
  });

  it("keeps the invoice covered with the caveat when Udyam registration is after acceptance", () => {
    expect(coverage(invoiceWith({ udyamRegisteredOn: "2026-09-03" }))).toStrictEqual({
      applicable: true,
      caveat: "registered_after_supply",
      ruleIds: ["MSMED-SCOPE"],
    });
  });

  it.each(["2026-09-02", "2026-01-15"])("gives no caveat when Udyam registration is on or before acceptance (%s)", (registeredOn) => {
    const result = coverage(invoiceWith({ udyamRegisteredOn: registeredOn }));
    expect(result).toStrictEqual({ applicable: true, ruleIds: [] });
    expect(result).not.toHaveProperty("caveat");
  });

  it("does not apply the caveat to a non-covered supplier", () => {
    const result = coverage(invoiceWith({ supplierActivity: "trading", udyamRegisteredOn: "2026-09-03" }));
    expect(result).toStrictEqual({ applicable: false, reason: "trader", ruleIds: ["MSMED-SCOPE"] });
  });
});
