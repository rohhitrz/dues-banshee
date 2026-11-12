import { describe, expect, it } from "vitest";
import {
  MAX_PAISE,
  validateBankRate,
  validateHistory,
  validateInvoice,
  validateLadderConfig,
} from "../src/validate";
import { ValidationError } from "../src/validation-error";
import type { EscalationHistory, Invoice } from "../src/types";
import { bankRate575, sharmaTradersInvoice } from "./fixtures";

/** Runs `fn`, asserts it throws a ValidationError, and returns that error. */
function catchValidationError(fn: () => void): ValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return error as ValidationError;
  }
  throw new Error("expected a ValidationError but nothing was thrown");
}

function invoiceWith(overrides: Partial<Invoice>): Invoice {
  return { ...sharmaTradersInvoice, ...overrides };
}

describe("validateInvoice", () => {
  it("accepts the Sharma Traders fixture", () => {
    expect(() => validateInvoice(sharmaTradersInvoice)).not.toThrow();
  });

  it("accepts MAX_PAISE as the amount", () => {
    expect(() => validateInvoice(invoiceWith({ amountPaise: MAX_PAISE }))).not.toThrow();
  });

  it("accepts a paid invoice with paidOn on acceptedOn and optional fields present", () => {
    const invoice = invoiceWith({ paidOn: "2026-09-02", udyamRegisteredOn: "2020-01-01" });
    expect(() => validateInvoice(invoice)).not.toThrow();
  });

  it("names acceptedOn for the impossible date 2026-02-30", () => {
    const error = catchValidationError(() => validateInvoice(invoiceWith({ acceptedOn: "2026-02-30" })));
    expect(error.field).toBe("acceptedOn");
    expect(error.value).toBe("2026-02-30");
  });

  it("names acceptedOn for a non-padded date", () => {
    const error = catchValidationError(() => validateInvoice(invoiceWith({ acceptedOn: "2026-9-2" })));
    expect(error.field).toBe("acceptedOn");
  });

  it.each([
    ["0", 0],
    ["1.5", 1.5],
    ["MAX_PAISE + 1", MAX_PAISE + 1],
  ])("names amountPaise when it is %s", (_label, amountPaise) => {
    const error = catchValidationError(() => validateInvoice(invoiceWith({ amountPaise })));
    expect(error.field).toBe("amountPaise");
  });

  it("names agreedTermDays when it is 0", () => {
    const error = catchValidationError(() => validateInvoice(invoiceWith({ agreedTermDays: 0 })));
    expect(error.field).toBe("agreedTermDays");
  });

  it("names paidOn when it is before acceptedOn", () => {
    const error = catchValidationError(() => validateInvoice(invoiceWith({ paidOn: "2026-09-01" })));
    expect(error.field).toBe("paidOn");
  });

  it("names paidOn when it is not a real date", () => {
    const error = catchValidationError(() => validateInvoice(invoiceWith({ paidOn: "2026-13-01" })));
    expect(error.field).toBe("paidOn");
  });

  it('names supplierActivity for "retail"', () => {
    const invoice = { ...sharmaTradersInvoice, supplierActivity: "retail" } as unknown as Invoice;
    const error = catchValidationError(() => validateInvoice(invoice));
    expect(error.field).toBe("supplierActivity");
  });

  it("names udyamRegisteredOn when it is not a real date", () => {
    const error = catchValidationError(() =>
      validateInvoice(invoiceWith({ udyamRegisteredOn: "2027-02-29" })),
    );
    expect(error.field).toBe("udyamRegisteredOn");
  });
});

describe("validateBankRate", () => {
  it("accepts the 5.75% fixture and both boundaries", () => {
    expect(() => validateBankRate(bankRate575)).not.toThrow();
    expect(() => validateBankRate({ annualBps: 0, asOf: "2026-10-07" })).not.toThrow();
    expect(() => validateBankRate({ annualBps: 5000, asOf: "2026-10-07" })).not.toThrow();
  });

  it.each([-1, 5001])("names annualBps when it is %i", (annualBps) => {
    const error = catchValidationError(() => validateBankRate({ ...bankRate575, annualBps }));
    expect(error.field).toBe("annualBps");
  });

  it("names asOf when it is not a real date", () => {
    const error = catchValidationError(() => validateBankRate({ ...bankRate575, asOf: "2026-04-31" }));
    expect(error.field).toBe("asOf");
  });
});

describe("validateHistory", () => {
  const validHistory: EscalationHistory = [
    { kind: "step", step: "whatsapp_nudge", on: "2026-10-18" },
    { kind: "step", step: "whatsapp_paylink", on: "2026-10-25" },
    { kind: "promise", promisedDate: "2026-11-05", amountPaise: 41_200_000, recordedOn: "2026-10-30" },
  ];

  it("accepts an empty history and a valid mixed history", () => {
    expect(() => validateHistory([])).not.toThrow();
    expect(() => validateHistory(validHistory)).not.toThrow();
  });

  it("does not reject a promise recorded after its promised date", () => {
    const history: EscalationHistory = [
      { kind: "promise", promisedDate: "2026-11-05", amountPaise: 100, recordedOn: "2026-11-20" },
    ];
    expect(() => validateHistory(history)).not.toThrow();
  });

  it("reports history[2].promisedDate for a bad promised date on the third event", () => {
    const history: EscalationHistory = [
      validHistory[0]!,
      validHistory[1]!,
      { kind: "promise", promisedDate: "2026-02-30", amountPaise: 100, recordedOn: "2026-10-30" },
    ];
    const error = catchValidationError(() => validateHistory(history));
    expect(error.field).toBe("history[2].promisedDate");
  });

  it("reports history[1].step for an unknown ladder step", () => {
    const history = [
      validHistory[0],
      { kind: "step", step: "carrier_pigeon", on: "2026-10-25" },
    ] as unknown as EscalationHistory;
    const error = catchValidationError(() => validateHistory(history));
    expect(error.field).toBe("history[1].step");
  });

  it("reports history[0].on for a bad step date", () => {
    const history: EscalationHistory = [{ kind: "step", step: "voice_call", on: "2026-00-10" }];
    const error = catchValidationError(() => validateHistory(history));
    expect(error.field).toBe("history[0].on");
  });

  it.each([0, -5, 1.5])("reports history[0].amountPaise when a promise amount is %s", (amountPaise) => {
    const history: EscalationHistory = [
      { kind: "promise", promisedDate: "2026-11-05", amountPaise, recordedOn: "2026-10-30" },
    ];
    const error = catchValidationError(() => validateHistory(history));
    expect(error.field).toBe("history[0].amountPaise");
  });

  it("reports history[3].recordedOn for a bad recorded date", () => {
    const history: EscalationHistory = [
      ...validHistory,
      { kind: "promise", promisedDate: "2026-11-05", amountPaise: 100, recordedOn: "yesterday" },
    ];
    const error = catchValidationError(() => validateHistory(history));
    expect(error.field).toBe("history[3].recordedOn");
  });

  it("reports history[0].kind for an unknown event kind", () => {
    const history = [{ kind: "call", on: "2026-10-18" }] as unknown as EscalationHistory;
    const error = catchValidationError(() => validateHistory(history));
    expect(error.field).toBe("history[0].kind");
  });
});

describe("validateLadderConfig", () => {
  it("accepts a positive integer gap", () => {
    expect(() => validateLadderConfig({ stepGapDays: 7 })).not.toThrow();
    expect(() => validateLadderConfig({ stepGapDays: 1 })).not.toThrow();
  });

  it.each([0, -1, 2.5])("names stepGapDays when it is %s", (stepGapDays) => {
    const error = catchValidationError(() => validateLadderConfig({ stepGapDays }));
    expect(error.field).toBe("stepGapDays");
  });
});
