import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays } from "../src/calendar-date";
import { coverage } from "../src/coverage";
import { dueDate } from "../src/due-date";
import { nextEscalationStep } from "../src/escalation-ladder";
import { statutoryInterest } from "../src/statutory-interest";
import { taxBomb } from "../src/tax-bomb";
import type { BankRate, CalendarDate, EscalationHistory, Invoice, LadderConfig } from "../src/types";
import { MAX_PAISE } from "../src/validate";
import { ValidationError } from "../src/validation-error";
import { arbBankRate, arbHistory, arbInvalidDateString, arbInvoice, arbLadderConfig, arbToday } from "./arbitraries";

/** A fully valid argument set for every public function that takes input. */
interface ValidInputs {
  invoice: Invoice;
  today: CalendarDate;
  bankRate: BankRate;
  history: EscalationHistory;
  config: LadderConfig;
}

const arbValidInputs: fc.Arbitrary<ValidInputs> = arbInvoice.chain((invoice) =>
  fc
    .tuple(arbToday(invoice), arbBankRate, arbHistory(invoice), arbLadderConfig)
    .map(([today, bankRate, history, config]) => ({ invoice, today, bankRate, history, config })),
);

/** Calls `fn` and asserts it throws a ValidationError whose `field` is `field`. */
function expectRejected(fn: () => unknown, field: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  expect((thrown as ValidationError).field).toBe(field);
}

/** Every public function that takes an Invoice, called with otherwise valid arguments. */
function expectInvoiceRejected(valid: ValidInputs, invoice: Invoice, field: string): void {
  const { today, bankRate, history, config } = valid;
  expectRejected(() => coverage(invoice), field);
  expectRejected(() => dueDate(invoice), field);
  expectRejected(() => statutoryInterest(invoice, today, bankRate), field);
  expectRejected(() => taxBomb(invoice, today), field);
  expectRejected(() => nextEscalationStep(invoice, history, today, config), field);
}

/** Copies the invoice with one field replaced by a value the type system would reject. */
function corrupt(invoice: Invoice, field: string, value: unknown): Invoice {
  return { ...invoice, [field]: value } as unknown as Invoice;
}

// ---------------------------------------------------------------------------
// Corrupt value generators
// ---------------------------------------------------------------------------

const arbFraction: fc.Arbitrary<number> = fc
  .double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
  .filter((n) => !Number.isInteger(n));

const arbNonFinite: fc.Arbitrary<number> = fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);

/** Amounts that are not integers in 1..1e12. */
const arbBadAmount: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1_000_000, max: 0 }),
  fc.integer({ min: MAX_PAISE + 1, max: Number.MAX_SAFE_INTEGER }),
  fc.double({ min: 0.01, max: MAX_PAISE, noNaN: true }).filter((n) => !Number.isInteger(n)),
  arbFraction,
  arbNonFinite,
);

/** Terms that are not positive integers. */
const arbBadTerm: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1000, max: 0 }),
  arbFraction,
  arbNonFinite,
);

/** Basis points that are not integers in 0..5000. */
const arbBadBps: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1_000_000, max: -1 }),
  fc.integer({ min: 5001, max: 1_000_000 }),
  fc.double({ min: 0.01, max: 5000, noNaN: true }).filter((n) => !Number.isInteger(n)),
  arbFraction,
  arbNonFinite,
);

/** Step gaps that are not positive integers. */
const arbBadGap: fc.Arbitrary<number> = arbBadTerm;

const ACTIVITIES: readonly string[] = ["manufacturing", "services", "trading"];

/** Strings outside the SupplierActivity enum (including near misses). */
const arbBadActivity: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ maxLength: 12 }),
    fc.constantFrom("", "Manufacturing", "TRADING", "service", "trader", " services", "retail", "wholesale"),
  )
  .filter((s) => !ACTIVITIES.includes(s));

describe("Property 2: Invalid input is rejected with the field name", () => {
  // Feature: legal-engine, Property 2: Invalid input is rejected with the field name
  // **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**

  it("rejects a malformed or impossible acceptedOn", () => {
    fc.assert(
      fc.property(arbValidInputs, arbInvalidDateString, (valid, bad) => {
        expectInvoiceRejected(valid, corrupt(valid.invoice, "acceptedOn", bad), "acceptedOn");
      }),
    );
  });

  it("rejects a malformed or impossible paidOn", () => {
    fc.assert(
      fc.property(arbValidInputs, arbInvalidDateString, (valid, bad) => {
        expectInvoiceRejected(valid, corrupt(valid.invoice, "paidOn", bad), "paidOn");
      }),
    );
  });

  it("rejects a malformed or impossible udyamRegisteredOn", () => {
    fc.assert(
      fc.property(arbValidInputs, arbInvalidDateString, (valid, bad) => {
        expectInvoiceRejected(valid, corrupt(valid.invoice, "udyamRegisteredOn", bad), "udyamRegisteredOn");
      }),
    );
  });

  it("rejects a paidOn before acceptedOn", () => {
    fc.assert(
      fc.property(arbValidInputs, fc.integer({ min: 1, max: 800 }), (valid, daysBefore) => {
        const paidOn = addDays(valid.invoice.acceptedOn, -daysBefore);
        expectInvoiceRejected(valid, corrupt(valid.invoice, "paidOn", paidOn), "paidOn");
      }),
    );
  });

  it("rejects an amountPaise outside 1..1e12 or non-integer", () => {
    fc.assert(
      fc.property(arbValidInputs, arbBadAmount, (valid, bad) => {
        expectInvoiceRejected(valid, corrupt(valid.invoice, "amountPaise", bad), "amountPaise");
      }),
    );
  });

  it("rejects an agreedTermDays that is not a positive integer", () => {
    fc.assert(
      fc.property(arbValidInputs, arbBadTerm, (valid, bad) => {
        expectInvoiceRejected(valid, corrupt(valid.invoice, "agreedTermDays", bad), "agreedTermDays");
      }),
    );
  });

  it("rejects a supplierActivity outside the enum", () => {
    fc.assert(
      fc.property(arbValidInputs, arbBadActivity, (valid, bad) => {
        expectInvoiceRejected(valid, corrupt(valid.invoice, "supplierActivity", bad), "supplierActivity");
      }),
    );
  });

  it("rejects a malformed or impossible today", () => {
    fc.assert(
      fc.property(arbValidInputs, arbInvalidDateString, (valid, bad) => {
        const { invoice, bankRate, history, config } = valid;
        expectRejected(() => statutoryInterest(invoice, bad, bankRate), "today");
        expectRejected(() => taxBomb(invoice, bad), "today");
        expectRejected(() => nextEscalationStep(invoice, history, bad, config), "today");
      }),
    );
  });

  it("rejects a malformed or impossible bank rate asOf", () => {
    fc.assert(
      fc.property(arbValidInputs, arbInvalidDateString, (valid, bad) => {
        const bankRate = { ...valid.bankRate, asOf: bad };
        expectRejected(() => statutoryInterest(valid.invoice, valid.today, bankRate), "asOf");
      }),
    );
  });

  it("rejects an annualBps outside 0..5000 or non-integer", () => {
    fc.assert(
      fc.property(arbValidInputs, arbBadBps, (valid, bad) => {
        const bankRate = { ...valid.bankRate, annualBps: bad };
        expectRejected(() => statutoryInterest(valid.invoice, valid.today, bankRate), "annualBps");
      }),
    );
  });

  it("rejects a stepGapDays that is not a positive integer", () => {
    fc.assert(
      fc.property(arbValidInputs, arbBadGap, (valid, bad) => {
        const config = { ...valid.config, stepGapDays: bad };
        expectRejected(() => nextEscalationStep(valid.invoice, valid.history, valid.today, config), "stepGapDays");
      }),
    );
  });
});
