import { afterEach, describe, expect, it, vi } from "vitest";
import { dueDate, nextEscalationStep, statutoryInterest, taxBomb } from "../src/index";
import type { EscalationHistory, Invoice } from "../src/types";
import { bankRate575, sharmaTradersInvoice } from "./fixtures";

// Sharma Traders: due 2026-10-17, so 2026-11-12 is 26 days overdue.
const TODAY = "2026-11-12";
const NO_HISTORY: EscalationHistory = [];

function runAll(invoice: Invoice, today: string) {
  return {
    dueDate: dueDate(invoice),
    statutoryInterest: statutoryInterest(invoice, today, bankRate575),
    taxBomb: taxBomb(invoice, today),
    nextEscalationStep: nextEscalationStep(invoice, NO_HISTORY, today),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("purity: the system clock is never read", () => {
  it("gives deeply identical results at two different system instants", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2020-01-01T00:00:00+05:30"));
    const first = runAll(sharmaTradersInvoice, TODAY);

    vi.setSystemTime(new Date("2031-06-15T23:59:59+05:30"));
    const second = runAll(sharmaTradersInvoice, TODAY);

    expect(second).toEqual(first);
  });

  it("returns the Sharma Traders numbers regardless of the system clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1999-12-31T12:00:00Z"));

    const result = runAll(sharmaTradersInvoice, TODAY);

    expect(result.dueDate).toMatchObject({ dueDate: "2026-10-17" });
    expect(result.statutoryInterest).toMatchObject({ interestPaise: 512794, accrualDays: 26 });
    expect(result.taxBomb).toMatchObject({ status: "armed", daysLeft: 139 });
    expect(result.nextEscalationStep).toMatchObject({ action: "advance", step: "whatsapp_nudge" });
  });

  it("restores real timers after the fake-timer tests", () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});

describe("late-registered Sharma invoice carries the caveat", () => {
  const lateInvoice: Invoice = { ...sharmaTradersInvoice, udyamRegisteredOn: "2026-09-10" };

  it("dueDate keeps the invoice covered and flags registered_after_supply", () => {
    const result = dueDate(lateInvoice);
    expect(result).toMatchObject({
      applicable: true,
      dueDate: "2026-10-17",
      caveat: "registered_after_supply",
    });
    expect(result.ruleIds).toContain("MSMED-15");
    expect(result.ruleIds).toContain("MSMED-SCOPE");
  });

  it("statutoryInterest has the same numbers plus the caveat", () => {
    const result = statutoryInterest(lateInvoice, TODAY, bankRate575);
    expect(result).toMatchObject({
      applicable: true,
      interestPaise: 512794,
      caveat: "registered_after_supply",
    });
    expect(result.ruleIds).toContain("MSMED-16");
    expect(result.ruleIds).toContain("MSMED-SCOPE");
  });

  it("taxBomb has the same numbers plus the caveat", () => {
    const result = taxBomb(lateInvoice, TODAY);
    expect(result).toMatchObject({
      applicable: true,
      status: "armed",
      daysLeft: 139,
      caveat: "registered_after_supply",
    });
    expect(result.ruleIds).toContain("IT-43BH");
    expect(result.ruleIds).toContain("MSMED-SCOPE");
  });

  it("nextEscalationStep advances and carries the caveat after the due date", () => {
    const result = nextEscalationStep(lateInvoice, NO_HISTORY, TODAY);
    expect(result).toMatchObject({
      action: "advance",
      applicable: true,
      step: "whatsapp_nudge",
      caveat: "registered_after_supply",
    });
    expect(result.ruleIds).toContain("MSMED-15");
    expect(result.ruleIds).toContain("MSMED-SCOPE");
  });

  it("a wait decision carries the caveat and MSMED-SCOPE too", () => {
    // 2026-10-17 is the due date itself, so the invoice is not yet overdue.
    const result = nextEscalationStep(lateInvoice, NO_HISTORY, "2026-10-17");
    expect(result).toMatchObject({
      action: "wait",
      reason: "not_overdue",
      caveat: "registered_after_supply",
    });
    expect(result.ruleIds).toContain("MSMED-SCOPE");
  });

  it("an invoice registered on the acceptance date has no caveat", () => {
    const sameDay: Invoice = { ...sharmaTradersInvoice, udyamRegisteredOn: "2026-09-02" };
    for (const result of Object.values(runAll(sameDay, TODAY))) {
      expect(result).not.toHaveProperty("caveat");
      expect(result.ruleIds).not.toContain("MSMED-SCOPE");
    }
  });
});
