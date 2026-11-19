// Property tests for `buildCandleTimeline` (debtor-ui, Properties 5 to 7; buyer-voice-call, Property 7).
// Shared generators come first so the later properties can reuse them.
import type {
  BuyerVoiceCall,
  DebtorData,
  DebtorEventRow,
  DebtorPromiseRow,
  EscalationAction,
  GraveyardInvoiceRecord,
  Supplier,
} from "@dues-banshee/db";
import {
  dueDate,
  formatDisplayDate,
  formatINR,
  LADDER_STEPS,
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
  type BankRate,
  type CalendarDate,
  type Invoice,
} from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDebtorView, type InvoicePanelView } from "../lib/debtor/build-debtor-view";
import { buildCandleTimeline, type EntryKind } from "../lib/debtor/candle-timeline";

// ---------------------------------------------------------------------------
// Shared generators and helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const FIRST_TODAY = Date.UTC(2024, 0, 1) / MS_PER_DAY;
const LAST_TODAY = Date.UTC(2027, 11, 31) / MS_PER_DAY;

const ACTIONS: readonly EscalationAction[] = ["drafted", "edited", "approved", "rejected", "expired"];

/** Epoch day to "YYYY-MM-DD". Every generated day lies in 2020..2030, so the year has four digits. */
function dayToDate(epochDay: number): CalendarDate {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

const SUPPLIER: Supplier = {
  id: "supplier-1",
  name: "Lakshmi Precision Components",
  udyamNumber: "UDYAM-MH-00-0000001",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
};

const BUYER = { id: "buyer-1", name: "Sharma Traders" };

interface InvoiceSpec {
  /** Days from Today to acceptedOn; positive means accepted after Today (not a Debtor_Invoice). */
  acceptedOffset: number;
  /** Days from acceptedOn back to the invoice date. */
  invoiceDateLead: number;
  amountPaise: number;
  agreedTermDays: number | undefined;
  category: Invoice["supplierCategory"];
  activity: Invoice["supplierActivity"];
  registeredShift: number | undefined;
  /** Days from acceptedOn to paidOn; may land after Today. */
  paidAfter: number | undefined;
}

interface EventSpec {
  /** Index into the invoice ids; values >= invoice count refer to unknown invoices. */
  invoiceSeed: number;
  step: (typeof LADDER_STEPS)[number];
  action: EscalationAction;
  offset: number;
}

interface PromiseSpec {
  invoiceSeed: number;
  promisedOffset: number;
  recordedOffset: number;
  amountPaise: number;
}

const arbInvoiceSpec: fc.Arbitrary<InvoiceSpec> = fc.record({
  acceptedOffset: fc.integer({ min: -400, max: 20 }),
  invoiceDateLead: fc.integer({ min: 0, max: 15 }),
  amountPaise: fc.integer({ min: 1, max: 10_000_000_000 }),
  agreedTermDays: fc.option(fc.integer({ min: 1, max: 120 }), { nil: undefined }),
  // Mostly covered suppliers so `due` entries are common; the other categories still appear.
  category: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("micro", "small") },
    { weight: 1, arbitrary: fc.constantFrom(...SUPPLIER_CATEGORIES) },
  ),
  activity: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("manufacturing", "services") },
    { weight: 1, arbitrary: fc.constantFrom(...SUPPLIER_ACTIVITIES) },
  ),
  registeredShift: fc.option(fc.integer({ min: -400, max: 400 }), { nil: undefined }),
  paidAfter: fc.option(fc.integer({ min: 0, max: 600 }), { nil: undefined }),
});

const arbEventSpec: fc.Arbitrary<EventSpec> = fc.record({
  invoiceSeed: fc.nat(),
  step: fc.constantFrom(...LADDER_STEPS),
  action: fc.constantFrom(...ACTIONS),
  offset: fc.integer({ min: -200, max: 40 }),
});

const arbPromiseSpec: fc.Arbitrary<PromiseSpec> = fc.record({
  invoiceSeed: fc.nat(),
  promisedOffset: fc.integer({ min: -60, max: 90 }),
  recordedOffset: fc.integer({ min: -200, max: 40 }),
  amountPaise: fc.integer({ min: 1, max: 10_000_000_000 }),
});

/** A fully built timeline input: Debtor_Invoice panels plus every source row, and the Today they were built for. */
interface TimelineScenario {
  today: CalendarDate;
  records: GraveyardInvoiceRecord[];
  events: DebtorEventRow[];
  promises: DebtorPromiseRow[];
  panels: InvoicePanelView[];
}

function toRecord(i: number, todayDay: number, s: InvoiceSpec): GraveyardInvoiceRecord {
  const acceptedDay = todayDay + s.acceptedOffset;
  const invoice: Invoice = {
    id: `inv-${i}`,
    amountPaise: s.amountPaise,
    acceptedOn: dayToDate(acceptedDay),
    supplierCategory: s.category,
    supplierActivity: s.activity,
    ...(s.agreedTermDays === undefined ? {} : { agreedTermDays: s.agreedTermDays }),
    ...(s.registeredShift === undefined ? {} : { udyamRegisteredOn: dayToDate(acceptedDay + s.registeredShift) }),
    ...(s.paidAfter === undefined ? {} : { paidOn: dayToDate(acceptedDay + s.paidAfter) }),
  };
  return {
    invoice,
    buyerName: BUYER.name,
    invoiceNumber: `LPC/${i}`,
    history: [],
    buyerId: BUYER.id,
    invoiceDate: dayToDate(acceptedDay - s.invoiceDateLead),
  };
}

/** Maps a seed to `inv-<k>` for k in 0..count+1, so some rows point at invoices that are not in the list. */
function invoiceIdFor(seed: number, count: number): string {
  return `inv-${seed % (count + 2)}`;
}

/**
 * Generates a scenario. Some invoices are accepted after Today (so they are not Debtor_Invoices and get no
 * panel), and some events and promises point at those or at unknown invoices. Row ids are unique.
 * Panels come from `buildDebtorView`, which takes them from the Graveyard_Builder.
 */
const arbTimelineScenario: fc.Arbitrary<TimelineScenario> = fc
  .record({
    todayDay: fc.integer({ min: FIRST_TODAY, max: LAST_TODAY }),
    invoices: fc.array(arbInvoiceSpec, { maxLength: 6 }),
    events: fc.array(arbEventSpec, { maxLength: 12 }),
    promises: fc.array(arbPromiseSpec, { maxLength: 8 }),
  })
  .map(({ todayDay, invoices, events, promises }) => {
    const today = dayToDate(todayDay);
    const records = invoices.map((s, i) => toRecord(i, todayDay, s));
    const eventRows: DebtorEventRow[] = events.map((e, i) => ({
      id: `ev-${i}`,
      invoiceId: invoiceIdFor(e.invoiceSeed, invoices.length),
      step: e.step,
      action: e.action,
      occurredOn: dayToDate(todayDay + e.offset),
    }));
    const promiseRows: DebtorPromiseRow[] = promises.map((p, i) => ({
      id: `pr-${i}`,
      invoiceId: invoiceIdFor(p.invoiceSeed, invoices.length),
      promisedDate: dayToDate(todayDay + p.promisedOffset),
      amountPaise: p.amountPaise,
      recordedOn: dayToDate(todayDay + p.recordedOffset),
      source: "manual",
      isPartial: false,
      supersededOn: null,
    }));
    const bankRate: BankRate = { annualBps: 575, asOf: dayToDate(todayDay - 30) };
    const data: DebtorData = { buyer: BUYER, records, events: eventRows, promises: promiseRows };
    const panels = buildDebtorView({ supplier: SUPPLIER, data, bankRate, drafts: [], calls: [], today, override: null }).panels;
    return { today, records, events: eventRows, promises: promiseRows, panels };
  });

/** Stable string identity of one entry (or expected entry): kind, source row id, date. */
function entryKey(kind: EntryKind, rowId: string, date: CalendarDate): string {
  return `${kind}|${rowId}|${date}`;
}

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

describe("buildCandleTimeline properties", () => {
  // Feature: debtor-ui, Property 5: Timeline membership and date exclusion
  // **Validates: Requirements 5.1, 5.2**
  it("Property 5: Timeline membership and date exclusion", () => {
    fc.assert(
      fc.property(arbTimelineScenario, ({ today, records, events, promises, panels }) => {
        // The Debtor_Invoices are the records accepted on or before Today.
        const debtor = records.filter((r) => r.invoice.acceptedOn <= today);
        const debtorIds = new Set(debtor.map((r) => r.invoice.id));
        expect(panels.map((p) => p.tombstone.id).sort()).toEqual([...debtorIds].sort());

        const expected: string[] = [];
        for (const r of debtor) {
          expected.push(entryKey("invoice", r.invoice.id, r.invoiceDate));
          // Engine due date, kept whatever its date (even after Today).
          const due = dueDate(r.invoice);
          if (due.applicable) expected.push(entryKey("due", r.invoice.id, due.dueDate));
          const paidOn = r.invoice.paidOn;
          if (paidOn !== undefined && paidOn <= today) expected.push(entryKey("payment", r.invoice.id, paidOn));
        }
        for (const e of events) {
          if (debtorIds.has(e.invoiceId) && e.occurredOn <= today) {
            expected.push(entryKey("ladder", e.id, e.occurredOn));
          }
        }
        for (const p of promises) {
          if (debtorIds.has(p.invoiceId) && p.recordedOn <= today) {
            expected.push(entryKey("promise", p.id, p.recordedOn));
          }
        }

        const timeline = buildCandleTimeline({ panels, records, events, promises, calls: [], today });
        const actual = timeline.map((t) => entryKey(t.kind, t.rowId, t.date));

        // Same multiset: nothing missing, nothing extra, no duplicates.
        expect([...actual].sort()).toEqual([...expected].sort());
        expect(new Set(actual).size).toBe(actual.length);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: debtor-ui, Property 6: Timeline order is total and input-order independent
  // **Validates: Requirements 5.3**
  it("Property 6: Timeline order is total and input-order independent", () => {
    const rank: Record<EntryKind, number> = { invoice: 0, due: 1, ladder: 2, call: 3, promise: 4, payment: 5 };
    /** A full-length shuffle of `items`. */
    const permutation = <T>(items: readonly T[]): fc.Arbitrary<T[]> =>
      fc.shuffledSubarray([...items], { minLength: items.length, maxLength: items.length });

    const arbShuffled = arbTimelineScenario.chain((s) =>
      fc.record({
        scenario: fc.constant(s),
        records: permutation(s.records),
        events: permutation(s.events),
        promises: permutation(s.promises),
        panels: permutation(s.panels),
      }),
    );

    fc.assert(
      fc.property(arbShuffled, ({ scenario, records, events, promises, panels }) => {
        const { today } = scenario;
        const base = buildCandleTimeline({
          panels: scenario.panels,
          records: scenario.records,
          events: scenario.events,
          promises: scenario.promises,
          calls: [],
          today,
        });
        const shuffled = buildCandleTimeline({ panels, records, events, promises, calls: [], today });

        // Identical output whatever the input order.
        expect(shuffled).toEqual(base);

        // Every adjacent pair is strictly ordered by date, then kind rank, then rowId (plain string comparison).
        for (let i = 1; i < shuffled.length; i++) {
          const a = shuffled[i - 1]!;
          const b = shuffled[i]!;
          const before =
            a.date < b.date ||
            (a.date === b.date &&
              (rank[a.kind] < rank[b.kind] || (rank[a.kind] === rank[b.kind] && a.rowId < b.rowId)));
          expect(before).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: debtor-ui, Property 7: Candle look encodes data
  // **Validates: Requirements 5.6**
  it("Property 7: Candle look encodes data", () => {
    /**
     * The base scenario spreads due dates around Today by chance. This variant moves Today onto
     * `dueDate + k` (k in -2..2) for one invoice, so due dates strictly before, exactly on and strictly
     * after Today are all hit often. Panels are rebuilt for the new Today; the source rows are unchanged.
     */
    const arbRetargeted = fc
      .record({ scenario: arbTimelineScenario, pick: fc.nat(), k: fc.integer({ min: -2, max: 2 }) })
      .map(({ scenario, pick, k }): TimelineScenario => {
        const dated = scenario.records.flatMap((r) => {
          const due = dueDate(r.invoice);
          return due.applicable ? [due.dueDate] : [];
        });
        if (dated.length === 0) return scenario;
        const anchor = dated[pick % dated.length]!;
        const today = dayToDate(Date.parse(anchor) / MS_PER_DAY + k);
        const bankRate: BankRate = { annualBps: 575, asOf: dayToDate(Date.parse(today) / MS_PER_DAY - 30) };
        const data: DebtorData = {
          buyer: BUYER,
          records: scenario.records,
          events: scenario.events,
          promises: scenario.promises,
        };
        const panels = buildDebtorView({ supplier: SUPPLIER, data, bankRate, drafts: [], calls: [], today, override: null }).panels;
        return { ...scenario, today, panels };
      });

    fc.assert(
      fc.property(fc.oneof(arbTimelineScenario, arbRetargeted), ({ today, records, events, promises, panels }) => {
        const resurrectedIds = new Set(panels.filter((p) => p.tombstone.state === "resurrected").map((p) => p.tombstone.id));
        const timeline = buildCandleTimeline({ panels, records, events, promises, calls: [], today });

        for (const entry of timeline) {
          // Lit exactly when the entry's date has been reached.
          expect(entry.lit).toBe(entry.date <= today);

          if (entry.kind === "promise" || entry.kind === "payment") {
            expect(entry.tone).toBe("spectral");
          } else if (entry.kind === "due") {
            // A due entry's rowId is its invoice id, which is a Debtor_Invoice with a panel.
            const ember = today > entry.date && !resurrectedIds.has(entry.rowId);
            expect(entry.tone).toBe(ember ? "ember" : "bone");
          } else {
            expect(entry.tone).toBe("bone");
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// buyer-voice-call Property 7
// ---------------------------------------------------------------------------

type CallOutcomeName = "promise" | "dispute" | "no_promise" | "incomplete" | "consent_declined";
type CallStatusName = BuyerVoiceCall["status"];

/** Outcome texts as written in Req 9 criterion 4. */
const SPEC_OUTCOME_TEXT: Record<CallOutcomeName, string> = {
  promise: "promise to pay",
  dispute: "disputed",
  no_promise: "no promise",
  incomplete: "incomplete",
  consent_declined: "declined the AI call",
};

/** Entry_Kind order for entries on the same date, as written in Req 9 criterion 4. */
const SPEC_KIND_ORDER: readonly EntryKind[] = ["invoice", "due", "ladder", "call", "promise", "payment"];

/** `m:ss` from whole seconds. */
function specDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

interface VoicePromiseSpec {
  invoiceSeed: number;
  promisedOffset: number;
  /** Mostly close to Today so rows land on both sides of the boundary. */
  recordedOffset: number;
  amountPaise: number;
  source: "manual" | "voice";
  isPartial: boolean;
  supersededOffset: number | null;
}

interface CallSpec {
  invoiceSeed: number;
  callOffset: number;
  status: CallStatusName;
  outcome: CallOutcomeName;
  durationSeconds: number;
}

const arbVoicePromiseSpec: fc.Arbitrary<VoicePromiseSpec> = fc.record({
  invoiceSeed: fc.nat(),
  promisedOffset: fc.integer({ min: -30, max: 60 }),
  recordedOffset: fc.oneof(
    { weight: 2, arbitrary: fc.integer({ min: -2, max: 2 }) },
    { weight: 1, arbitrary: fc.integer({ min: -200, max: 40 }) },
  ),
  amountPaise: fc.integer({ min: 1, max: 10_000_000_000 }),
  source: fc.constantFrom("manual", "voice"),
  isPartial: fc.boolean(),
  supersededOffset: fc.option(
    fc.oneof(
      { weight: 2, arbitrary: fc.integer({ min: -2, max: 2 }) },
      { weight: 1, arbitrary: fc.integer({ min: -60, max: 60 }) },
    ),
    { nil: null },
  ),
});

const arbCallSpec: fc.Arbitrary<CallSpec> = fc.record({
  invoiceSeed: fc.nat(),
  callOffset: fc.oneof(
    { weight: 2, arbitrary: fc.integer({ min: -2, max: 2 }) },
    { weight: 1, arbitrary: fc.integer({ min: -60, max: 30 }) },
  ),
  status: fc.oneof(
    { weight: 4, arbitrary: fc.constant<CallStatusName>("ended") },
    { weight: 1, arbitrary: fc.constantFrom<CallStatusName>("created", "live", "expired") },
  ),
  outcome: fc.constantFrom<CallOutcomeName>("promise", "dispute", "no_promise", "incomplete", "consent_declined"),
  // Includes 0, 59, 60, 61, 300 so the m:ss padding and minute carry are hit.
  durationSeconds: fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom(0, 7, 59, 60, 61, 125, 299, 300) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: 300 }) },
  ),
});

describe("buildCandleTimeline promise and call entries", () => {
  // Feature: buyer-voice-call, Property 7: Timeline promise and call entries
  // **Validates: Requirements 9.3, 9.4**
  it("Property 7: Timeline promise and call entries", () => {
    const arbVoiceScenario = fc.record({
      scenario: arbTimelineScenario,
      promiseSpecs: fc.array(arbVoicePromiseSpec, { maxLength: 8 }),
      callSpecs: fc.array(arbCallSpec, { maxLength: 8 }),
    });

    fc.assert(
      fc.property(arbVoiceScenario, ({ scenario, promiseSpecs, callSpecs }) => {
        const { today, records, events, panels } = scenario;
        const todayDay = Date.parse(today) / MS_PER_DAY;
        const panelIds = panels.map((p) => p.tombstone.id);
        // Rows may point at an invoice with no panel (accepted after Today, or unknown); those get no entry.
        const pickInvoice = (seed: number): string => invoiceIdFor(seed, records.length);

        const promises: DebtorPromiseRow[] = promiseSpecs.map((s, i) => ({
          id: `pr-${i}`,
          invoiceId: pickInvoice(s.invoiceSeed),
          promisedDate: dayToDate(todayDay + s.promisedOffset),
          amountPaise: s.amountPaise,
          recordedOn: dayToDate(todayDay + s.recordedOffset),
          source: s.source,
          isPartial: s.isPartial,
          supersededOn: s.supersededOffset === null ? null : dayToDate(todayDay + s.supersededOffset),
        }));
        const calls: BuyerVoiceCall[] = callSpecs.map((s, i) => {
          const ended = s.status === "ended";
          return {
            id: `call-${i}`,
            invoiceId: pickInvoice(s.invoiceSeed),
            callToday: dayToDate(todayDay + s.callOffset),
            status: s.status,
            startedAt: new Date(Date.UTC(2026, 10, 12, 6, 0, 0)),
            endedAt: ended ? new Date(Date.UTC(2026, 10, 12, 6, 5, 0)) : null,
            durationSeconds: ended ? s.durationSeconds : null,
            outcome: ended ? s.outcome : null,
            transcript: [],
            toolCalls: [],
          };
        });

        const timeline = buildCandleTimeline({ panels, records, events, promises, calls, today });
        const hasPanel = (id: string): boolean => panelIds.includes(id);

        // Promise entries: one per visible row (recorded on or before Today) of a Debtor_Invoice.
        const expectedPromises = new Map<string, { date: string; text: string }>();
        for (const p of promises) {
          if (!hasPanel(p.invoiceId) || p.recordedOn > today) continue;
          let text = `Promised ${formatINR(p.amountPaise, "full")} by ${formatDisplayDate(p.promisedDate)}`;
          if (p.source === "voice") text += p.isPartial ? " (by voice, partial)" : " (by voice)";
          if (p.supersededOn !== null && p.supersededOn <= today) text += " (replaced)";
          expectedPromises.set(p.id, { date: p.recordedOn, text });
        }
        const actualPromises = timeline.filter((t) => t.kind === "promise");
        expect(actualPromises.length).toBe(expectedPromises.size);
        for (const entry of actualPromises) {
          const want = expectedPromises.get(entry.rowId);
          expect(want).toBeDefined();
          expect(entry.date).toBe(want!.date);
          expect(entry.text).toBe(want!.text);
        }

        // Call entries: one per ended call of a Debtor_Invoice dated on or before Today.
        const expectedCalls = new Map<string, { date: string; text: string }>();
        for (const c of calls) {
          if (!hasPanel(c.invoiceId) || c.status !== "ended" || c.callToday > today) continue;
          expectedCalls.set(c.id, {
            date: c.callToday,
            text: `Voice call: ${SPEC_OUTCOME_TEXT[c.outcome!]}, ${specDuration(c.durationSeconds!)}`,
          });
        }
        const actualCalls = timeline.filter((t) => t.kind === "call");
        expect(actualCalls.length).toBe(expectedCalls.size);
        for (const entry of actualCalls) {
          const want = expectedCalls.get(entry.rowId);
          expect(want).toBeDefined();
          expect(entry.date).toBe(want!.date);
          expect(entry.text).toBe(want!.text);
        }

        // Order: by date, and for the same date by the Req 9 C4 kind order.
        for (let i = 1; i < timeline.length; i++) {
          const a = timeline[i - 1]!;
          const b = timeline[i]!;
          expect(a.date <= b.date).toBe(true);
          if (a.date === b.date) {
            expect(SPEC_KIND_ORDER.indexOf(a.kind)).toBeLessThanOrEqual(SPEC_KIND_ORDER.indexOf(b.kind));
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
