import { compareDates, isValidCalendarDate } from "./calendar-date";
import type {
  BankRate,
  CalendarDate,
  EscalationHistory,
  Invoice,
  LadderConfig,
  LadderStep,
  Paise,
  SupplierActivity,
  SupplierCategory,
} from "./types";
import { ValidationError } from "./validation-error";

/**
 * Largest invoice amount the engine accepts: ₹1,000 crore in paise.
 * Single definition; `statutory-interest.ts` re-exports it later.
 */
export const MAX_PAISE = 1_00_000_00_00_000;

const SUPPLIER_CATEGORIES: readonly SupplierCategory[] = ["micro", "small", "medium", "unregistered"];
const SUPPLIER_ACTIVITIES: readonly SupplierActivity[] = ["manufacturing", "services", "trading"];
// Mirrors LADDER_STEPS in escalation-ladder.ts, which imports this module (no cycle allowed).
const LADDER_STEP_NAMES: readonly LadderStep[] = [
  "whatsapp_nudge",
  "whatsapp_paylink",
  "voice_call",
  "legal_notice",
  "odr_pack",
];

/** Throws unless `value` is a real "YYYY-MM-DD" calendar day (years 1900..9999). */
export function assertCalendarDate(field: string, value: unknown): asserts value is CalendarDate {
  if (!isValidCalendarDate(value)) {
    throw new ValidationError(field, "must be a valid calendar date in YYYY-MM-DD format", value);
  }
}

/** Throws unless `value` is a non-negative safe integer amount in paise. */
export function assertPaise(field: string, value: unknown): asserts value is Paise {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(field, "must be a non-negative safe integer number of paise", value);
  }
}

function assertPositiveInteger(field: string, value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(field, "must be a positive integer", value);
  }
}

function assertOneOf<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(field, `must be one of ${allowed.join(", ")}`, value);
  }
}

/** Checks invoice fields in declaration order and throws on the first problem. */
export function validateInvoice(invoice: Invoice): void {
  if (typeof invoice.id !== "string" || invoice.id.length === 0) {
    throw new ValidationError("id", "must be a non-empty string", invoice.id);
  }
  if (
    typeof invoice.amountPaise !== "number" ||
    !Number.isInteger(invoice.amountPaise) ||
    invoice.amountPaise < 1 ||
    invoice.amountPaise > MAX_PAISE
  ) {
    throw new ValidationError(
      "amountPaise",
      `must be an integer between 1 and ${MAX_PAISE} paise`,
      invoice.amountPaise,
    );
  }
  assertCalendarDate("acceptedOn", invoice.acceptedOn);
  if (invoice.agreedTermDays !== undefined) {
    assertPositiveInteger("agreedTermDays", invoice.agreedTermDays);
  }
  assertOneOf("supplierCategory", invoice.supplierCategory, SUPPLIER_CATEGORIES);
  assertOneOf("supplierActivity", invoice.supplierActivity, SUPPLIER_ACTIVITIES);
  if (invoice.udyamRegisteredOn !== undefined) {
    assertCalendarDate("udyamRegisteredOn", invoice.udyamRegisteredOn);
  }
  if (invoice.paidOn !== undefined) {
    assertCalendarDate("paidOn", invoice.paidOn);
    if (compareDates(invoice.paidOn, invoice.acceptedOn) < 0) {
      throw new ValidationError("paidOn", "must not be before acceptedOn", invoice.paidOn);
    }
  }
}

export function validateBankRate(bankRate: BankRate): void {
  if (
    typeof bankRate.annualBps !== "number" ||
    !Number.isInteger(bankRate.annualBps) ||
    bankRate.annualBps < 0 ||
    bankRate.annualBps > 5000
  ) {
    throw new ValidationError("annualBps", "must be an integer between 0 and 5000", bankRate.annualBps);
  }
  assertCalendarDate("asOf", bankRate.asOf);
}

/**
 * Checks every event and reports indexed field paths such as `history[2].promisedDate`.
 * `recordedOn <= promisedDate` is deliberately not enforced.
 */
export function validateHistory(history: EscalationHistory): void {
  if (!Array.isArray(history)) {
    throw new ValidationError("history", "must be an array", history);
  }
  history.forEach((event, i) => {
    const path = `history[${i}]`;
    const kind: unknown = (event as { kind?: unknown } | null)?.kind;
    if (kind === "step") {
      assertOneOf(`${path}.step`, event.kind === "step" ? event.step : undefined, LADDER_STEP_NAMES);
      assertCalendarDate(`${path}.on`, event.kind === "step" ? event.on : undefined);
    } else if (kind === "promise" && event.kind === "promise") {
      assertCalendarDate(`${path}.promisedDate`, event.promisedDate);
      assertPositiveInteger(`${path}.amountPaise`, event.amountPaise);
      assertCalendarDate(`${path}.recordedOn`, event.recordedOn);
    } else {
      throw new ValidationError(`${path}.kind`, 'must be "step" or "promise"', kind);
    }
  });
}

export function validateLadderConfig(config: LadderConfig): void {
  assertPositiveInteger("stepGapDays", config.stepGapDays);
}
