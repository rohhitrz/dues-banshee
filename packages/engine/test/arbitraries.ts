import fc from "fast-check";
import { addDays, financialYearEnd, fromEpochDay, isValidCalendarDate, toEpochDay } from "../src/calendar-date";
import type {
  BankRate,
  CalendarDate,
  EscalationEvent,
  EscalationHistory,
  Invoice,
  LadderConfig,
  LadderStep,
  Paise,
  SupplierActivity,
  SupplierCategory,
} from "../src/types";

/** Mirrors `LADDER_STEPS` in src/escalation-ladder.ts (not written yet), in rank order. */
const LADDER_STEPS: readonly LadderStep[] = [
  "whatsapp_nudge",
  "whatsapp_paylink",
  "voice_call",
  "legal_notice",
  "odr_pack",
];

const MAX_AMOUNT_PAISE = 10_000_000_000_000;
const DEFAULT_MIN_DATE: CalendarDate = "2020-01-01";
const DEFAULT_MAX_DATE: CalendarDate = "2035-12-31";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Last day of `month` (1..12) in `year`, as an epoch day. */
function monthEndEpochDay(year: number, month: number): number {
  const nextFirst: CalendarDate =
    month === 12 ? `${String(year + 1).padStart(4, "0")}-01-01` : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
  return toEpochDay(nextFirst) - 1;
}

function epochDayOf(year: number, month: number, day: number): number {
  return toEpochDay(`${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
}

/**
 * A valid Calendar_Date in [min, max] (inclusive). Mostly uniform, with extra weight on
 * month ends, the last day of February (28/29), 31 March and 1 April.
 */
export function arbCalendarDate(
  min: CalendarDate = DEFAULT_MIN_DATE,
  max: CalendarDate = DEFAULT_MAX_DATE,
): fc.Arbitrary<CalendarDate> {
  const minDay = toEpochDay(min);
  const maxDay = toEpochDay(max);
  const minYear = Number(min.slice(0, 4));
  const maxYear = Number(max.slice(0, 4));
  const clamp = (epochDay: number): number => Math.min(Math.max(epochDay, minDay), maxDay);

  const uniform = fc.integer({ min: minDay, max: maxDay });
  const special = fc
    .tuple(
      fc.integer({ min: minYear, max: maxYear }),
      fc.integer({ min: 1, max: 12 }),
      fc.constantFrom("monthEnd", "feb28", "febEnd", "mar31", "apr1"),
    )
    .map(([year, month, kind]) => {
      switch (kind) {
        case "monthEnd":
          return monthEndEpochDay(year, month);
        case "feb28":
          return epochDayOf(year, 2, 28);
        case "febEnd":
          return monthEndEpochDay(year, 2);
        case "mar31":
          return epochDayOf(year, 3, 31);
        default:
          return epochDayOf(year, 4, 1);
      }
    });

  return fc
    .oneof({ weight: 3, arbitrary: uniform }, { weight: 2, arbitrary: special })
    .map((epochDay) => fromEpochDay(clamp(epochDay)));
}

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Strings that are not a valid Calendar_Date (wrong shape, impossible days, years outside 1900..9999). */
export const arbInvalidDateString: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ maxLength: 16 }),
    fc.constantFrom(
      "",
      "2026-1-5",
      "2026-01-5",
      "2026-1-05",
      "26-01-05",
      "20260105",
      "2026/01/05",
      "2026-01-05T00:00:00Z",
      " 2026-01-05",
      "2026-01-055",
      "02026-01-05",
      "1899-12-31",
      "0000-01-01",
      "tomorrow",
    ),
    // Unpadded month/day.
    fc
      .tuple(fc.integer({ min: 2020, max: 2035 }), fc.integer({ min: 1, max: 9 }), fc.integer({ min: 1, max: 9 }))
      .map(([y, m, d]) => `${y}-${m}-${d}`),
    // Month 00 or 13.
    fc
      .tuple(fc.integer({ min: 2020, max: 2035 }), fc.constantFrom("00", "13"), fc.integer({ min: 1, max: 28 }))
      .map(([y, m, d]) => `${y}-${m}-${pad2(d)}`),
    // Day 00 or 32.
    fc
      .tuple(fc.integer({ min: 2020, max: 2035 }), fc.integer({ min: 1, max: 12 }), fc.constantFrom("00", "32"))
      .map(([y, m, d]) => `${y}-${pad2(m)}-${d}`),
    // 29 February in a non-leap year.
    fc
      .integer({ min: 1900, max: 9999 })
      .filter((y) => !isLeap(y))
      .map((y) => `${String(y).padStart(4, "0")}-02-29`),
    // 31st of a 30-day month.
    fc
      .tuple(fc.integer({ min: 2020, max: 2035 }), fc.constantFrom("04", "06", "09", "11"))
      .map(([y, m]) => `${y}-${m}-31`),
    // Years outside the supported range.
    fc.tuple(fc.integer({ min: 0, max: 1899 }), fc.constantFrom("01-01", "12-31")).map(([y, md]) => `${String(y).padStart(4, "0")}-${md}`),
  )
  .filter((s) => !isValidCalendarDate(s));

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/** Amounts 1..1e13 paise, weighted towards small and typical invoices, with the maximum included. */
const arbAmountPaise: fc.Arbitrary<Paise> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 100_000 }) },
  { weight: 4, arbitrary: fc.integer({ min: 100_000, max: 10_000_000_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: MAX_AMOUNT_PAISE }) },
  { weight: 1, arbitrary: fc.constant(MAX_AMOUNT_PAISE) },
);

const arbInvoiceId: fc.Arbitrary<string> = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,11}$/);

const optional = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(arb, { nil: undefined, freq: 3 });

interface InvoiceParts {
  id: string;
  amountPaise: Paise;
  acceptedOn: CalendarDate;
  agreedTermDays: number | undefined;
  supplierCategory: SupplierCategory;
  supplierActivity: SupplierActivity;
  udyamRegisteredOn: CalendarDate | undefined;
  paidOn: CalendarDate | undefined;
}

/** Builds an Invoice without ever setting an optional key to `undefined`. */
function makeInvoice(parts: InvoiceParts): Invoice {
  const invoice: Invoice = {
    id: parts.id,
    amountPaise: parts.amountPaise,
    acceptedOn: parts.acceptedOn,
    supplierCategory: parts.supplierCategory,
    supplierActivity: parts.supplierActivity,
  };
  if (parts.agreedTermDays !== undefined) invoice.agreedTermDays = parts.agreedTermDays;
  if (parts.udyamRegisteredOn !== undefined) invoice.udyamRegisteredOn = parts.udyamRegisteredOn;
  if (parts.paidOn !== undefined) invoice.paidOn = parts.paidOn;
  return invoice;
}

const arbAgreedTermDays: fc.Arbitrary<number | undefined> = optional(
  fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 120 }) },
    { weight: 1, arbitrary: fc.constantFrom(1, 15, 44, 45, 46) },
  ),
);

const arbUdyamRegisteredOn = (acceptedOn: CalendarDate): fc.Arbitrary<CalendarDate | undefined> =>
  optional(fc.integer({ min: -400, max: 400 }).map((offset) => addDays(acceptedOn, offset)));

const arbPaidOn = (acceptedOn: CalendarDate): fc.Arbitrary<CalendarDate | undefined> =>
  optional(fc.integer({ min: 0, max: 800 }).map((offset) => addDays(acceptedOn, offset)));

/**
 * Invoices with the given classification and optional fields. `acceptedOn` and
 * `agreedTermDays` come from the supplied arbitraries so callers can steer them.
 */
function arbInvoiceWith(
  classification: fc.Arbitrary<readonly [SupplierCategory, SupplierActivity]>,
  acceptedOnAndTerm: fc.Arbitrary<readonly [CalendarDate, number | undefined]>,
): fc.Arbitrary<Invoice> {
  return fc
    .tuple(arbInvoiceId, arbAmountPaise, classification, acceptedOnAndTerm)
    .chain(([id, amountPaise, [supplierCategory, supplierActivity], [acceptedOn, agreedTermDays]]) =>
      fc.tuple(arbUdyamRegisteredOn(acceptedOn), arbPaidOn(acceptedOn)).map(([udyamRegisteredOn, paidOn]) =>
        makeInvoice({
          id,
          amountPaise,
          acceptedOn,
          agreedTermDays,
          supplierCategory,
          supplierActivity,
          udyamRegisteredOn,
          paidOn,
        }),
      ),
    );
}

const coveredClassification: fc.Arbitrary<readonly [SupplierCategory, SupplierActivity]> = fc.tuple(
  fc.constantFrom<SupplierCategory>("micro", "small"),
  fc.constantFrom<SupplierActivity>("manufacturing", "services"),
);

const nonCoveredClassification: fc.Arbitrary<readonly [SupplierCategory, SupplierActivity]> = fc.oneof(
  fc.tuple(
    fc.constantFrom<SupplierCategory>("medium", "unregistered"),
    fc.constantFrom<SupplierActivity>("manufacturing", "services", "trading"),
  ),
  fc.tuple(fc.constantFrom<SupplierCategory>("micro", "small"), fc.constant<SupplierActivity>("trading")),
);

const arbAcceptedOnAndTerm: fc.Arbitrary<readonly [CalendarDate, number | undefined]> = fc.tuple(
  arbCalendarDate(),
  arbAgreedTermDays,
);

/**
 * Covered_Invoice branch for Property 11 / Requirement 5.5: `acceptedOn` falls between
 * 15 Feb and 31 Mar and the effective term pushes the Due_Date past 31 March, so the
 * Due_Date is after the Tax_Bomb_Date.
 */
const arbYearEndAcceptedOnAndTerm: fc.Arbitrary<readonly [CalendarDate, number | undefined]> = fc
  .integer({ min: 2020, max: 2035 })
  .chain((year) => {
    const mar31 = epochDayOf(year, 3, 31);
    // Accepted no more than 44 days before 31 Mar, so a 45-day term still lands after it.
    const earliest = Math.max(epochDayOf(year, 2, 15), mar31 - 44);
    return fc.integer({ min: earliest, max: mar31 }).chain((acceptedDay) => {
      const daysToMar31 = mar31 - acceptedDay;
      const longTerm = fc.integer({ min: daysToMar31 + 1, max: 120 });
      // The 15-day default applies when the term is absent.
      const term: fc.Arbitrary<number | undefined> =
        daysToMar31 < 15 ? fc.option(longTerm, { nil: undefined, freq: 4 }) : longTerm;
      return term.map((agreedTermDays): readonly [CalendarDate, number | undefined] => [
        fromEpochDay(acceptedDay),
        agreedTermDays,
      ]);
    });
  });

/** Covered_Invoice acceptance in the last weeks of the financial year (Due_Date after the Tax_Bomb_Date). */
export const arbCoveredInvoiceNearYearEnd: fc.Arbitrary<Invoice> = arbInvoiceWith(
  coveredClassification,
  arbYearEndAcceptedOnAndTerm,
);

/** Udyam micro/small supplier in manufacturing or services. Includes the 15 Feb to 31 Mar branch. */
export const arbCoveredInvoice: fc.Arbitrary<Invoice> = fc.oneof(
  { weight: 5, arbitrary: arbInvoiceWith(coveredClassification, arbAcceptedOnAndTerm) },
  { weight: 1, arbitrary: arbCoveredInvoiceNearYearEnd },
);

/** Medium or unregistered suppliers (any activity), or micro/small traders. */
export const arbNonCoveredInvoice: fc.Arbitrary<Invoice> = arbInvoiceWith(
  nonCoveredClassification,
  arbAcceptedOnAndTerm,
);

export const arbInvoice: fc.Arbitrary<Invoice> = fc.oneof(arbCoveredInvoice, arbNonCoveredInvoice);

/**
 * Property 5 pairing: the same covered invoice twice, once registered on or before
 * `acceptedOn` (or with no registration date), once registered strictly after it.
 */
export const arbLateRegistrationPair: fc.Arbitrary<{ onTime: Invoice; late: Invoice }> = fc
  .tuple(arbCoveredInvoice, optional(fc.integer({ min: -400, max: 0 })), fc.integer({ min: 1, max: 400 }))
  .map(([base, onTimeOffset, lateOffset]) => {
    const { udyamRegisteredOn: _ignored, ...rest } = base;
    void _ignored;
    const onTime: Invoice = { ...rest };
    if (onTimeOffset !== undefined) onTime.udyamRegisteredOn = addDays(base.acceptedOn, onTimeOffset);
    const late: Invoice = { ...rest, udyamRegisteredOn: addDays(base.acceptedOn, lateOffset) };
    return { onTime, late };
  });

// ---------------------------------------------------------------------------
// Bank rate, today, history, config
// ---------------------------------------------------------------------------

/** annualBps 0..1000 biased to 0, 1 and 575; any asOf date. */
export const arbBankRate: fc.Arbitrary<BankRate> = fc.record({
  annualBps: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(0, 1, 575) },
    { weight: 4, arbitrary: fc.integer({ min: 0, max: 1000 }) },
  ),
  asOf: arbCalendarDate(),
});

/** Statutory Due_Date computed locally so the generators do not depend on src/due-date.ts. */
function localDueDate(inv: Invoice): CalendarDate {
  const term = inv.agreedTermDays === undefined ? 15 : Math.min(inv.agreedTermDays, 45);
  return addDays(inv.acceptedOn, term);
}

/**
 * `today` from `acceptedOn - 30` to `acceptedOn + 900`, biased to the Due_Date, the day
 * after it, whole 30-day rests after it, the Tax_Bomb_Date and the day after that.
 */
export function arbToday(inv: Invoice): fc.Arbitrary<CalendarDate> {
  const acceptedDay = toEpochDay(inv.acceptedOn);
  const dueDay = toEpochDay(localDueDate(inv));
  const taxBombDay = toEpochDay(financialYearEnd(inv.acceptedOn));
  const maxRests = Math.max(1, Math.floor((acceptedDay + 900 - dueDay) / 30));

  return fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: acceptedDay - 30, max: acceptedDay + 900 }).map(fromEpochDay) },
    { weight: 3, arbitrary: fc.constantFrom(dueDay, dueDay + 1, taxBombDay, taxBombDay + 1).map(fromEpochDay) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: maxRests }).map((m) => fromEpochDay(dueDay + 30 * m)) },
  );
}

/**
 * Up to 8 history events dated from `acceptedOn` onward. Promises have
 * `recordedOn <= promisedDate` and an amount of 1..A.
 */
export function arbHistory(inv: Invoice): fc.Arbitrary<EscalationHistory> {
  const acceptedDay = toEpochDay(inv.acceptedOn);
  const onOrAfterAccepted = fc.integer({ min: 0, max: 900 }).map((offset) => fromEpochDay(acceptedDay + offset));

  const stepEvent: fc.Arbitrary<EscalationEvent> = fc
    .tuple(fc.constantFrom(...LADDER_STEPS), onOrAfterAccepted)
    .map(([step, on]) => ({ kind: "step", step, on }));

  const promiseEvent: fc.Arbitrary<EscalationEvent> = fc
    .tuple(
      fc.integer({ min: 0, max: 900 }),
      fc.integer({ min: 0, max: 60 }),
      fc.integer({ min: 1, max: inv.amountPaise }),
    )
    .map(([recordedOffset, wait, amountPaise]) => ({
      kind: "promise",
      promisedDate: fromEpochDay(acceptedDay + recordedOffset + wait),
      amountPaise,
      recordedOn: fromEpochDay(acceptedDay + recordedOffset),
    }));

  return fc.array(fc.oneof({ weight: 3, arbitrary: stepEvent }, { weight: 1, arbitrary: promiseEvent }), {
    maxLength: 8,
  });
}

/** stepGapDays 1..30, with the default of 7 favoured. */
export const arbLadderConfig: fc.Arbitrary<LadderConfig> = fc
  .oneof({ weight: 1, arbitrary: fc.constant(7) }, { weight: 3, arbitrary: fc.integer({ min: 1, max: 30 }) })
  .map((stepGapDays) => ({ stepGapDays }));
