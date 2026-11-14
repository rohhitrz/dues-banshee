import { describe, expect, it } from "vitest";
import { activePromiseUntil, hasActivePromise } from "../src/index";
import type { CalendarDate, EscalationHistory, PromiseEvent } from "../src/index";

// Requirements 6.1, 6.6, 10.6

const TODAY = "2026-11-12";

function promise(promisedDate: CalendarDate): PromiseEvent {
  return { kind: "promise", promisedDate, amountPaise: 41200000, recordedOn: "2026-11-05" };
}

const stepsOnly: EscalationHistory = [
  { kind: "step", step: "whatsapp_nudge", on: "2026-10-18" },
  { kind: "step", step: "whatsapp_paylink", on: "2026-10-25" },
];

describe("hasActivePromise", () => {
  it("is false for a promise dated the day before today", () => {
    expect(hasActivePromise([promise("2026-11-11")], TODAY)).toBe(false);
  });

  it("is true for a promise dated today", () => {
    expect(hasActivePromise([promise("2026-11-12")], TODAY)).toBe(true);
  });

  it("is true for a promise dated the day after today", () => {
    expect(hasActivePromise([promise("2026-11-13")], TODAY)).toBe(true);
  });

  it("is false for an empty history", () => {
    expect(hasActivePromise([], TODAY)).toBe(false);
  });

  it("is false for a history with only step events", () => {
    expect(hasActivePromise(stepsOnly, TODAY)).toBe(false);
  });
});

describe("activePromiseUntil", () => {
  it("is null for an empty history", () => {
    expect(activePromiseUntil([], TODAY)).toBeNull();
  });

  it("is null for a history with only step events", () => {
    expect(activePromiseUntil(stepsOnly, TODAY)).toBeNull();
  });

  it("returns the latest active promise date", () => {
    const history: EscalationHistory = [promise("2026-11-10"), promise("2026-11-20"), promise("2026-11-15")];
    expect(activePromiseUntil(history, TODAY)).toBe("2026-11-20");
  });
});

describe("engine index exports", () => {
  it("exposes activePromiseUntil and hasActivePromise", () => {
    expect(typeof activePromiseUntil).toBe("function");
    expect(typeof hasActivePromise).toBe("function");
  });
});
