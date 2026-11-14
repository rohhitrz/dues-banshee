import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  dueDate,
  formatDisplayDate,
  formatINR,
  fromEpochDay,
  statutoryInterest,
  taxBomb,
} from "@dues-banshee/engine";
import type { BankRate, CalendarDate, Invoice } from "@dues-banshee/engine";
import { PAY_LINK_TEXT, buildFactSheet, fillPlaceholders } from "../src/core/fact-sheet";
import type { FactSheet } from "../src/core/fact-sheet";

const NUM_RUNS = 100;

/** 2020-01-01 as days since 1970-01-01, and the width of the generated window (about 16 years). */
const EPOCH_START = 18262;
const EPOCH_SPAN = 5843;

/** Same 1e12-paise ceiling the Engine accepts. */
const MAX_AMOUNT_PAISE = 1_00_000_00_00_000;

const dateArb: fc.Arbitrary<CalendarDate> = fc
  .integer({ min: EPOCH_START, max: EPOCH_START + EPOCH_SPAN })
  .map(fromEpochDay);

const amountArb = fc.oneof(
  fc.integer({ min: 1, max: 100_000 }),
  fc.integer({ min: 1, max: MAX_AMOUNT_PAISE }),
);

/** A Covered_Invoice: Udyam micro/small supplier in manufacturing or services, unpaid. */
const coveredInvoiceArb: fc.Arbitrary<Invoice> = fc
  .record({
    amountPaise: amountArb,
    acceptedOn: dateArb,
    agreedTermDays: fc.option(fc.integer({ min: 1, max: 120 }), { nil: undefined }),
    supplierCategory: fc.constantFrom("micro", "small"),
    supplierActivity: fc.constantFrom("manufacturing", "services"),
    udyamOffset: fc.option(fc.integer({ min: -400, max: 400 }), { nil: undefined }),
  })
  .map(({ amountPaise, acceptedOn, agreedTermDays, supplierCategory, supplierActivity, udyamOffset }) => {
    const invoice: Invoice = {
      id: "inv-1",
      amountPaise,
      acceptedOn,
      supplierCategory,
      supplierActivity,
    };
    if (agreedTermDays !== undefined) invoice.agreedTermDays = agreedTermDays;
    if (udyamOffset !== undefined) {
      invoice.udyamRegisteredOn = fromEpochDayOffset(acceptedOn, udyamOffset);
    }
    return invoice;
  });

function fromEpochDayOffset(date: CalendarDate, offset: number): CalendarDate {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return fromEpochDay(Math.round(ms / 86_400_000) + offset);
}

/** Today is on or after acceptance, from the day itself to about 2.5 years later. */
const scenarioArb = coveredInvoiceArb.chain((invoice) =>
  fc.integer({ min: 0, max: 900 }).map((offset) => ({
    invoice,
    today: fromEpochDayOffset(invoice.acceptedOn, offset),
  })),
);

const bankRateArb: fc.Arbitrary<BankRate> = fc.record({
  annualBps: fc.oneof(fc.constantFrom(0, 1, 575), fc.integer({ min: 0, max: 1000 })),
  asOf: dateArb,
});

/** Untrusted text, including strings that look like Placeholder tokens. */
const hostileTextArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.constantFrom(
    "{{principal}}",
    "{{pay_link}}",
    "Sharma {{principal}} Traders",
    "{{buyer_name}}",
    "{{{{principal}}}}",
    "{{due_date}}{{interest}}",
  ),
);

const NAMES: ReadonlyArray<keyof FactSheet> = [
  "buyer_name",
  "invoice_number",
  "principal",
  "due_date",
  "interest",
  "rate_as_of",
  "tax_bomb_date",
  "tax_bomb_days",
  "deduction_at_risk",
  "pay_link",
];

describe("buildFactSheet properties", () => {
  // Feature: escalation-ladder, Property 4: Placeholders are filled once, from Engine output
  it("Property 4: every value is the Engine output formatted by formatINR / formatDisplayDate", () => {
    // **Validates: Requirements 5.2, 5.3, 5.5**
    fc.assert(
      fc.property(
        scenarioArb,
        bankRateArb,
        hostileTextArb,
        hostileTextArb,
        ({ invoice, today }, bankRate, buyerName, invoiceNumber) => {
          const due = dueDate(invoice);
          const bomb = taxBomb(invoice, today);
          const interest = statutoryInterest(invoice, today, bankRate);
          if (!due.applicable || !bomb.applicable || !interest.applicable) {
            throw new Error("generated invoice must be covered");
          }

          const facts = buildFactSheet({ invoice, buyerName, invoiceNumber }, today, bankRate);

          expect(facts).toEqual({
            buyer_name: buyerName,
            invoice_number: invoiceNumber,
            principal: formatINR(invoice.amountPaise, "full"),
            due_date: formatDisplayDate(due.dueDate),
            interest: formatINR(interest.interestPaise, "full"),
            rate_as_of: formatDisplayDate(bankRate.asOf),
            tax_bomb_date: formatDisplayDate(bomb.taxBombDate),
            tax_bomb_days: String(bomb.daysLeft),
            deduction_at_risk: formatINR(bomb.deductionAtRiskPaise, "full"),
            pay_link: "[payment link added on send]",
          });
          expect(facts.pay_link).toBe(PAY_LINK_TEXT);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: escalation-ladder, Property 4: Placeholders are filled once, from Engine output
  it("Property 4: with no Bank_Rate, interest and rate_as_of are null and the rest is unchanged", () => {
    // **Validates: Requirements 5.2, 5.3**
    fc.assert(
      fc.property(scenarioArb, bankRateArb, ({ invoice, today }, bankRate) => {
        const record = { invoice, buyerName: "Sharma Traders", invoiceNumber: "INV-7" };
        const without = buildFactSheet(record, today, null);
        const withRate = buildFactSheet(record, today, bankRate);

        expect(without.interest).toBeNull();
        expect(without.rate_as_of).toBeNull();
        expect({ ...without, interest: null, rate_as_of: null }).toEqual({
          ...withRate,
          interest: null,
          rate_as_of: null,
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

/** A fully filled FactSheet with arbitrary (possibly token-like) text values. */
const factsArb: fc.Arbitrary<FactSheet> = fc
  .tuple(hostileTextArb, hostileTextArb, hostileTextArb, hostileTextArb)
  .map(([buyer_name, invoice_number, principal, interest]) => ({
    buyer_name,
    invoice_number,
    principal,
    due_date: "10 Mar 2027",
    interest,
    rate_as_of: "7 Oct 2026",
    tax_bomb_date: "31 Mar 2027",
    tax_bomb_days: "139",
    deduction_at_risk: "₹1,00,000.00",
    pay_link: PAY_LINK_TEXT,
  }));

/** Text that cannot hold a token start, so it only ever matches itself. */
const literalArb = fc.stringMatching(/^[A-Za-z0-9 .,:;!?-]{0,12}$/);

type Piece = { kind: "literal"; text: string } | { kind: "token"; name: keyof FactSheet };

const piecesArb: fc.Arbitrary<Piece[]> = fc.array(
  fc.oneof(
    literalArb.map((text): Piece => ({ kind: "literal", text })),
    fc.constantFrom(...NAMES).map((name): Piece => ({ kind: "token", name })),
  ),
  { maxLength: 14 },
);

describe("fillPlaceholders properties", () => {
  // Feature: escalation-ladder, Property 4: Placeholders are filled once, from Engine output
  it("Property 4: each token occurrence is replaced exactly once and inserted values are never re-scanned", () => {
    // **Validates: Requirements 5.2, 5.5**
    fc.assert(
      fc.property(piecesArb, factsArb, (pieces, facts) => {
        const text = pieces.map((p) => (p.kind === "literal" ? p.text : `{{${p.name}}}`)).join("");
        const expected = pieces.map((p) => (p.kind === "literal" ? p.text : (facts[p.name] as string))).join("");
        expect(fillPlaceholders(text, facts)).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: escalation-ladder, Property 4: Placeholders are filled once, from Engine output
  it("Property 4: a buyer_name holding {{principal}} or {{pay_link}} stays literal in the output", () => {
    // **Validates: Requirements 5.2, 5.5**
    fc.assert(
      fc.property(
        scenarioArb,
        fc.constantFrom("{{principal}}", "{{pay_link}}"),
        hostileTextArb,
        hostileTextArb,
        ({ invoice, today }, token, before, after) => {
          const buyerName = `${before}${token}${after}`;
          const facts = buildFactSheet({ invoice, buyerName, invoiceNumber: "INV-7" }, today, null);
          const out = fillPlaceholders("Dear {{buyer_name}}, pay {{principal}} via {{pay_link}}.", facts);

          expect(out).toBe(`Dear ${buyerName}, pay ${facts.principal} via ${facts.pay_link}.`);
          expect(out).toContain(buyerName);
          expect(out).toContain(token);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: escalation-ladder, Property 4: Placeholders are filled once, from Engine output
  it("Property 4: text with no tokens is returned unchanged", () => {
    // **Validates: Requirements 5.2**
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }).filter((s) => !/\{\{[a-z_]+\}\}/.test(s)),
        factsArb,
        (text, facts) => {
          expect(fillPlaceholders(text, facts)).toBe(text);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: escalation-ladder, Property 4: Placeholders are filled once, from Engine output
  it("Property 4: unknown tokens are left as-is", () => {
    // **Validates: Requirements 5.2**
    const unknownTokenArb = fc.oneof(
      fc
        .stringMatching(/^[a-z_]{1,12}$/)
        .filter((n) => !(NAMES as readonly string[]).includes(n))
        .map((n) => `{{${n}}}`),
      fc.constantFrom(
        "{{constructor}}",
        "{{__proto__}}",
        "{{toString}}",
        "{{PRINCIPAL}}",
        "{{ principal }}",
        "{principal}",
        "{{}}",
      ),
    );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(literalArb, unknownTokenArb), { minLength: 1, maxLength: 8 }),
        factsArb,
        (parts, facts) => {
          const text = parts.map(([lit, tok]) => lit + tok).join("");
          expect(fillPlaceholders(text, facts)).toBe(text);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: escalation-ladder, Property 4: Placeholders are filled once, from Engine output
  it("Property 4: a Placeholder with a null value (no Bank_Rate) is left as-is", () => {
    // **Validates: Requirements 5.3**
    fc.assert(
      fc.property(factsArb, (facts) => {
        const noRate: FactSheet = { ...facts, interest: null, rate_as_of: null };
        expect(fillPlaceholders("{{interest}} as of {{rate_as_of}}", noRate)).toBe(
          "{{interest}} as of {{rate_as_of}}",
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
