import { describe, expect, it } from "vitest";
import {
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
  ValidationError,
  addDays,
  financialYearEnd,
  fromEpochDay,
  isValidCalendarDate,
  isoWeekday,
  validateInvoice,
} from "../src/index";
import type { Invoice } from "../src/index";
import { sharmaTradersInvoice } from "./fixtures";

describe("engine public exports", () => {
  it("exposes the five names from the package entry point", () => {
    expect(typeof validateInvoice).toBe("function");
    expect(typeof isValidCalendarDate).toBe("function");
    expect(typeof fromEpochDay).toBe("function");
    expect(Array.isArray(SUPPLIER_CATEGORIES)).toBe(true);
    expect(Array.isArray(SUPPLIER_ACTIVITIES)).toBe(true);
  });

  it("exports SUPPLIER_CATEGORIES in declaration order, frozen", () => {
    expect(SUPPLIER_CATEGORIES).toEqual(["micro", "small", "medium", "unregistered"]);
    expect(Object.isFrozen(SUPPLIER_CATEGORIES)).toBe(true);
  });

  it("exports SUPPLIER_ACTIVITIES in declaration order, frozen", () => {
    expect(SUPPLIER_ACTIVITIES).toEqual(["manufacturing", "services", "trading"]);
    expect(Object.isFrozen(SUPPLIER_ACTIVITIES)).toBe(true);
  });

  it("validateInvoice accepts every exported category and rejects an unknown one", () => {
    for (const supplierCategory of SUPPLIER_CATEGORIES) {
      expect(() => validateInvoice({ ...sharmaTradersInvoice, supplierCategory })).not.toThrow();
    }
    const invalid = { ...sharmaTradersInvoice, supplierCategory: "large" } as unknown as Invoice;
    expect(() => validateInvoice(invalid)).toThrow(ValidationError);
  });

  it("re-exports working calendar helpers", () => {
    expect(isValidCalendarDate("2026-09-02")).toBe(true);
    expect(isValidCalendarDate("2026-02-30")).toBe(false);
    expect(isValidCalendarDate(fromEpochDay(0))).toBe(true);
  });

  it("exports addDays, financialYearEnd and isoWeekday from the package entry point", () => {
    expect(addDays("2026-11-12", 8)).toBe("2026-11-20");
    expect(financialYearEnd("2026-11-12")).toBe("2027-03-31");
    expect(isoWeekday("2026-11-12")).toBe(4);
  });
});
