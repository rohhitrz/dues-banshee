import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  toEngineInvoice,
  type BuyerVoiceCall,
  type DebtorEventRow,
  type DebtorPromiseRow,
  type GraveyardInvoiceRecord,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import { formatINR, type BankRate } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { buildDebtorView } from "@/lib/debtor/build-debtor-view";
import { ACTION_TEXT, CALL_OUTCOME_TEXT, formatDuration, type TimelineEntry } from "@/lib/debtor/candle-timeline";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};

function timelineFor(
  buyer: { id: string; name: string },
  records: GraveyardInvoiceRecord[],
  events: DebtorEventRow[],
  promises: DebtorPromiseRow[],
  calls: BuyerVoiceCall[] = [],
): TimelineEntry[] {
  return buildDebtorView({
    supplier: SUPPLIER,
    data: { buyer, records, events, promises },
    bankRate: BANK_RATE,
    drafts: [],
    calls,
    today: TODAY,
    override: null,
  }).timeline;
}

// The demo seed's Sharma Traders invoice, accepted on 2026-09-02, 45 day agreed term.
function sharmaRecord(): GraveyardInvoiceRecord {
  const demo = DEMO_INVOICES.find((d) => d.invoiceNumber === "LPC/26-27/0412");
  if (demo === undefined) throw new Error("Sharma demo invoice missing");
  const row: InvoiceRow = {
    id: "inv-sharma",
    supplierId: SUPPLIER_ID,
    buyerId: "buyer-sharma",
    invoiceNumber: demo.invoiceNumber,
    invoiceNumberKey: demo.invoiceNumber.toLowerCase(),
    invoiceDate: demo.acceptedOn,
    acceptedOn: demo.acceptedOn,
    acceptanceDateDefaulted: false,
    agreedTermDays: demo.agreedTermDays ?? null,
    amountPaise: demo.amountPaise,
    paidOn: demo.paidOn ?? null,
    supplierCategory: SUPPLIER_ROW.supplierCategory,
    supplierActivity: SUPPLIER_ROW.supplierActivity,
    createdAt: new Date(0),
  };
  return {
    invoice: toEngineInvoice(row, SUPPLIER_ROW),
    buyerName: demo.buyerName,
    invoiceNumber: demo.invoiceNumber,
    history: [],
    buyerId: row.buyerId,
    invoiceDate: row.invoiceDate,
  };
}

const SHARMA_BUYER = { id: "buyer-sharma", name: "Sharma Traders" };

describe("buildCandleTimeline: Sharma Traders at 2026-11-12 (Req 10.2)", () => {
  it("has exactly the invoice and due entries when there is no history", () => {
    expect(timelineFor(SHARMA_BUYER, [sharmaRecord()], [], [])).toEqual([
      {
        kind: "invoice",
        date: "2026-09-02",
        dateText: "2 Sep 2026",
        text: "Invoice LPC/26-27/0412 raised for " + formatINR(41200000, "full"),
        invoiceNumber: "LPC/26-27/0412",
        rowId: "inv-sharma",
        lit: true,
        tone: "bone",
      },
      {
        kind: "due",
        date: "2026-10-17",
        dateText: "17 Oct 2026",
        text: "Due date (MSMED-15)",
        invoiceNumber: "LPC/26-27/0412",
        rowId: "inv-sharma",
        lit: true,
        tone: "ember",
      },
    ]);
  });

  it("puts ladder and promise entries between them in order, with the literal texts", () => {
    const events: DebtorEventRow[] = [
      { id: "ev-approved", invoiceId: "inv-sharma", step: "whatsapp_nudge", action: "approved", occurredOn: "2026-11-11" },
      { id: "ev-drafted", invoiceId: "inv-sharma", step: "whatsapp_nudge", action: "drafted", occurredOn: "2026-11-10" },
    ];
    const promises: DebtorPromiseRow[] = [
      { id: "pr-1", invoiceId: "inv-sharma", promisedDate: "2026-11-20", amountPaise: 41200000, recordedOn: "2026-11-11", source: "manual", isPartial: false, supersededOn: null },
    ];
    expect(timelineFor(SHARMA_BUYER, [sharmaRecord()], events, promises)).toEqual([
      {
        kind: "invoice",
        date: "2026-09-02",
        dateText: "2 Sep 2026",
        text: "Invoice LPC/26-27/0412 raised for " + formatINR(41200000, "full"),
        invoiceNumber: "LPC/26-27/0412",
        rowId: "inv-sharma",
        lit: true,
        tone: "bone",
      },
      {
        kind: "due",
        date: "2026-10-17",
        dateText: "17 Oct 2026",
        text: "Due date (MSMED-15)",
        invoiceNumber: "LPC/26-27/0412",
        rowId: "inv-sharma",
        lit: true,
        tone: "ember",
      },
      {
        kind: "ladder",
        date: "2026-11-10",
        dateText: "10 Nov 2026",
        text: "WhatsApp nudge drafted",
        invoiceNumber: "LPC/26-27/0412",
        rowId: "ev-drafted",
        lit: true,
        tone: "bone",
      },
      {
        kind: "ladder",
        date: "2026-11-11",
        dateText: "11 Nov 2026",
        text: "WhatsApp nudge approved",
        invoiceNumber: "LPC/26-27/0412",
        rowId: "ev-approved",
        lit: true,
        tone: "bone",
      },
      {
        kind: "promise",
        date: "2026-11-11",
        dateText: "11 Nov 2026",
        text: "Promised " + formatINR(41200000, "full") + " by 20 Nov 2026",
        invoiceNumber: "LPC/26-27/0412",
        rowId: "pr-1",
        lit: true,
        tone: "spectral",
      },
    ]);
  });
});

// Mixed fixture for one buyer at 2026-11-12. Due dates are the default 15 days after acceptance (MSMED-15).
function synthetic(
  id: string,
  invoiceNumber: string,
  acceptedOn: string,
  amountPaise: number,
  extra: { paidOn?: string; trading?: boolean } = {},
): GraveyardInvoiceRecord {
  return {
    invoice: {
      id,
      amountPaise,
      acceptedOn,
      supplierCategory: "micro",
      supplierActivity: extra.trading === true ? "trading" : "manufacturing",
      udyamRegisteredOn: "2024-04-15",
      ...(extra.paidOn === undefined ? {} : { paidOn: extra.paidOn }),
    },
    buyerName: "Mehra Metals",
    invoiceNumber,
    history: [],
    buyerId: "buyer-mehra",
    invoiceDate: acceptedOn,
  };
}

const MEHRA_BUYER = { id: "buyer-mehra", name: "Mehra Metals" };

// inv-a: due 2026-10-16, unpaid. inv-b: raised on that same day, due 2026-10-31. inv-c: due 2026-10-05, paid only
// on 2026-11-13 (after Today). inv-d: due 2026-11-20 (after Today). inv-e: due 2026-10-17, paid 2026-11-05.
// inv-f: a trader, not covered by MSMED.
const MEHRA_RECORDS = (): GraveyardInvoiceRecord[] => [
  synthetic("inv-a", "MM/26-27/0001", "2026-10-01", 10000000),
  synthetic("inv-b", "MM/26-27/0002", "2026-10-16", 2500000),
  synthetic("inv-c", "MM/26-27/0003", "2026-09-20", 4000000, { paidOn: "2026-11-13" }),
  synthetic("inv-d", "MM/26-27/0004", "2026-11-05", 3000000),
  synthetic("inv-e", "MM/26-27/0005", "2026-10-02", 5000000, { paidOn: "2026-11-05" }),
  synthetic("inv-f", "MM/26-27/0006", "2026-10-10", 1500000, { trading: true }),
];

const MEHRA_EVENTS = (): DebtorEventRow[] => [
  { id: "ev-1", invoiceId: "inv-a", step: "whatsapp_nudge", action: "drafted", occurredOn: "2026-10-20" },
  { id: "ev-2", invoiceId: "inv-a", step: "whatsapp_nudge", action: "edited", occurredOn: "2026-10-21" },
  { id: "ev-3", invoiceId: "inv-a", step: "whatsapp_nudge", action: "approved", occurredOn: "2026-10-22" },
  { id: "ev-4", invoiceId: "inv-b", step: "whatsapp_paylink", action: "rejected", occurredOn: "2026-11-01" },
  { id: "ev-5", invoiceId: "inv-b", step: "voice_call", action: "expired", occurredOn: "2026-11-02" },
  // Dated after Today: excluded.
  { id: "ev-6", invoiceId: "inv-a", step: "legal_notice", action: "drafted", occurredOn: "2026-11-13" },
  // Dated on Today: kept.
  { id: "ev-7", invoiceId: "inv-b", step: "odr_pack", action: "drafted", occurredOn: "2026-11-12" },
];

const MEHRA_PROMISES = (): DebtorPromiseRow[] => [
  { id: "pr-1", invoiceId: "inv-a", promisedDate: "2026-11-20", amountPaise: 10000000, recordedOn: "2026-10-22", source: "manual", isPartial: false, supersededOn: null },
  // Recorded after Today: excluded.
  { id: "pr-2", invoiceId: "inv-b", promisedDate: "2026-11-30", amountPaise: 2500000, recordedOn: "2026-11-14", source: "manual", isPartial: false, supersededOn: null },
];

const EXPECTED_MEHRA: TimelineEntry[] = [
  {
    kind: "invoice",
    date: "2026-09-20",
    dateText: "20 Sep 2026",
    text: "Invoice MM/26-27/0003 raised for " + formatINR(4000000, "full"),
    invoiceNumber: "MM/26-27/0003",
    rowId: "inv-c",
    lit: true,
    tone: "bone",
  },
  {
    kind: "invoice",
    date: "2026-10-01",
    dateText: "1 Oct 2026",
    text: "Invoice MM/26-27/0001 raised for " + formatINR(10000000, "full"),
    invoiceNumber: "MM/26-27/0001",
    rowId: "inv-a",
    lit: true,
    tone: "bone",
  },
  {
    kind: "invoice",
    date: "2026-10-02",
    dateText: "2 Oct 2026",
    text: "Invoice MM/26-27/0005 raised for " + formatINR(5000000, "full"),
    invoiceNumber: "MM/26-27/0005",
    rowId: "inv-e",
    lit: true,
    tone: "bone",
  },
  {
    // Paid only after Today, so still unpaid on Today and past its due date.
    kind: "due",
    date: "2026-10-05",
    dateText: "5 Oct 2026",
    text: "Due date (MSMED-15)",
    invoiceNumber: "MM/26-27/0003",
    rowId: "inv-c",
    lit: true,
    tone: "ember",
  },
  {
    // The not-covered trader: an invoice entry, and no due entry anywhere in this list.
    kind: "invoice",
    date: "2026-10-10",
    dateText: "10 Oct 2026",
    text: "Invoice MM/26-27/0006 raised for " + formatINR(1500000, "full"),
    invoiceNumber: "MM/26-27/0006",
    rowId: "inv-f",
    lit: true,
    tone: "bone",
  },
  {
    // Same date as the due entry of inv-a: invoice sorts before due.
    kind: "invoice",
    date: "2026-10-16",
    dateText: "16 Oct 2026",
    text: "Invoice MM/26-27/0002 raised for " + formatINR(2500000, "full"),
    invoiceNumber: "MM/26-27/0002",
    rowId: "inv-b",
    lit: true,
    tone: "bone",
  },
  {
    kind: "due",
    date: "2026-10-16",
    dateText: "16 Oct 2026",
    text: "Due date (MSMED-15)",
    invoiceNumber: "MM/26-27/0001",
    rowId: "inv-a",
    lit: true,
    tone: "ember",
  },
  {
    // Past its due date but paid by Today, so not ember.
    kind: "due",
    date: "2026-10-17",
    dateText: "17 Oct 2026",
    text: "Due date (MSMED-15)",
    invoiceNumber: "MM/26-27/0005",
    rowId: "inv-e",
    lit: true,
    tone: "bone",
  },
  {
    kind: "ladder",
    date: "2026-10-20",
    dateText: "20 Oct 2026",
    text: "WhatsApp nudge drafted",
    invoiceNumber: "MM/26-27/0001",
    rowId: "ev-1",
    lit: true,
    tone: "bone",
  },
  {
    kind: "ladder",
    date: "2026-10-21",
    dateText: "21 Oct 2026",
    text: "WhatsApp nudge edited",
    invoiceNumber: "MM/26-27/0001",
    rowId: "ev-2",
    lit: true,
    tone: "bone",
  },
  {
    kind: "ladder",
    date: "2026-10-22",
    dateText: "22 Oct 2026",
    text: "WhatsApp nudge approved",
    invoiceNumber: "MM/26-27/0001",
    rowId: "ev-3",
    lit: true,
    tone: "bone",
  },
  {
    // Same date as ev-3: ladder sorts before promise.
    kind: "promise",
    date: "2026-10-22",
    dateText: "22 Oct 2026",
    text: "Promised " + formatINR(10000000, "full") + " by 20 Nov 2026",
    invoiceNumber: "MM/26-27/0001",
    rowId: "pr-1",
    lit: true,
    tone: "spectral",
  },
  {
    kind: "due",
    date: "2026-10-31",
    dateText: "31 Oct 2026",
    text: "Due date (MSMED-15)",
    invoiceNumber: "MM/26-27/0002",
    rowId: "inv-b",
    lit: true,
    tone: "ember",
  },
  {
    kind: "ladder",
    date: "2026-11-01",
    dateText: "1 Nov 2026",
    text: "WhatsApp + UPI link rejected",
    invoiceNumber: "MM/26-27/0002",
    rowId: "ev-4",
    lit: true,
    tone: "bone",
  },
  {
    kind: "ladder",
    date: "2026-11-02",
    dateText: "2 Nov 2026",
    text: "Voice call expired",
    invoiceNumber: "MM/26-27/0002",
    rowId: "ev-5",
    lit: true,
    tone: "bone",
  },
  {
    kind: "invoice",
    date: "2026-11-05",
    dateText: "5 Nov 2026",
    text: "Invoice MM/26-27/0004 raised for " + formatINR(3000000, "full"),
    invoiceNumber: "MM/26-27/0004",
    rowId: "inv-d",
    lit: true,
    tone: "bone",
  },
  {
    // Same date as the invoice entry of inv-d: invoice sorts before payment.
    kind: "payment",
    date: "2026-11-05",
    dateText: "5 Nov 2026",
    text: "Paid. Resurrected",
    invoiceNumber: "MM/26-27/0005",
    rowId: "inv-e",
    lit: true,
    tone: "spectral",
  },
  {
    // Dated on Today: kept and lit.
    kind: "ladder",
    date: "2026-11-12",
    dateText: "12 Nov 2026",
    text: "MSME ODR pack drafted",
    invoiceNumber: "MM/26-27/0002",
    rowId: "ev-7",
    lit: true,
    tone: "bone",
  },
  {
    // Due after Today: kept, unlit, not ember.
    kind: "due",
    date: "2026-11-20",
    dateText: "20 Nov 2026",
    text: "Due date (MSMED-15)",
    invoiceNumber: "MM/26-27/0004",
    rowId: "inv-d",
    lit: false,
    tone: "bone",
  },
];

describe("buildCandleTimeline: mixed fixture at 2026-11-12 (Req 10.2)", () => {
  it("returns exactly the expected entries in order", () => {
    expect(timelineFor(MEHRA_BUYER, MEHRA_RECORDS(), MEHRA_EVENTS(), MEHRA_PROMISES())).toEqual(EXPECTED_MEHRA);
  });

  it("gives the same timeline when every input list is reversed", () => {
    expect(
      timelineFor(
        MEHRA_BUYER,
        MEHRA_RECORDS().reverse(),
        MEHRA_EVENTS().reverse(),
        MEHRA_PROMISES().reverse(),
      ),
    ).toEqual(EXPECTED_MEHRA);
  });

  it("excludes the ladder, promise and payment entries dated after Today", () => {
    const timeline = timelineFor(MEHRA_BUYER, MEHRA_RECORDS(), MEHRA_EVENTS(), MEHRA_PROMISES());
    expect(timeline.map((e) => e.rowId)).not.toContain("ev-6");
    expect(timeline.map((e) => e.rowId)).not.toContain("pr-2");
    // inv-c is paid on 2026-11-13, after Today: it has no payment entry.
    expect(timeline.filter((e) => e.kind === "payment").map((e) => e.rowId)).toEqual(["inv-e"]);
  });

  it("keeps the future due entry, unlit", () => {
    const timeline = timelineFor(MEHRA_BUYER, MEHRA_RECORDS(), MEHRA_EVENTS(), MEHRA_PROMISES());
    expect(timeline.filter((e) => e.kind === "due" && e.date > TODAY)).toEqual([
      {
        kind: "due",
        date: "2026-11-20",
        dateText: "20 Nov 2026",
        text: "Due date (MSMED-15)",
        invoiceNumber: "MM/26-27/0004",
        rowId: "inv-d",
        lit: false,
        tone: "bone",
      },
    ]);
  });

  it("gives a not-covered invoice an invoice entry and no due entry", () => {
    const timeline = timelineFor(MEHRA_BUYER, MEHRA_RECORDS(), MEHRA_EVENTS(), MEHRA_PROMISES());
    expect(timeline.filter((e) => e.rowId === "inv-f").map((e) => e.kind)).toEqual(["invoice"]);
  });

  it("orders two entries of different kinds on one date by kind", () => {
    const timeline = timelineFor(MEHRA_BUYER, MEHRA_RECORDS(), MEHRA_EVENTS(), MEHRA_PROMISES());
    const on = (date: string) => timeline.filter((e) => e.date === date).map((e) => `${e.kind}:${e.rowId}`);
    expect(on("2026-10-16")).toEqual(["invoice:inv-b", "due:inv-a"]);
    expect(on("2026-10-22")).toEqual(["ladder:ev-3", "promise:pr-1"]);
    expect(on("2026-11-05")).toEqual(["invoice:inv-d", "payment:inv-e"]);
  });

  it("does not mutate its inputs", () => {
    const records = MEHRA_RECORDS();
    const events = MEHRA_EVENTS();
    const promises = MEHRA_PROMISES();
    const before = structuredClone({ records, events, promises });
    timelineFor(MEHRA_BUYER, records, events, promises);
    expect({ records, events, promises }).toEqual(before);
  });
});

describe("a sent Escalation_Event (Req 5.4)", () => {
  it("gives the entry 'WhatsApp nudge sent' on the event's occurred_on date", () => {
    const events: DebtorEventRow[] = [
      { id: "ev-sent", invoiceId: "inv-sharma", step: "whatsapp_nudge", action: "sent", occurredOn: "2026-11-12" },
    ];
    expect(timelineFor(SHARMA_BUYER, [sharmaRecord()], events, []).filter((e) => e.kind === "ladder")).toEqual([
      {
        kind: "ladder",
        date: "2026-11-12",
        dateText: "12 Nov 2026",
        text: "WhatsApp nudge sent",
        invoiceNumber: "LPC/26-27/0412",
        rowId: "ev-sent",
        lit: true,
        tone: "bone",
      },
    ]);
  });
});

describe("ACTION_TEXT (Req 5.4, 5.5)", () => {
  it("maps each action to its literal text", () => {
    expect(ACTION_TEXT).toEqual({
      drafted: "drafted",
      edited: "edited",
      approved: "approved",
      rejected: "rejected",
      expired: "expired",
      sent: "sent",
    });
  });
});

const PROMISE_BASE: DebtorPromiseRow = {
  id: "pr-v",
  invoiceId: "inv-sharma",
  promisedDate: "2026-11-20",
  amountPaise: 41712794,
  recordedOn: "2026-11-12",
  source: "voice",
  isPartial: false,
  supersededOn: null,
};

describe("voice promise text (Req 9.3)", () => {
  const textOf = (p: DebtorPromiseRow): string | undefined =>
    timelineFor(SHARMA_BUYER, [sharmaRecord()], [], [p]).find((e) => e.kind === "promise")?.text;

  it("adds (by voice) to a voice promise", () => {
    expect(textOf(PROMISE_BASE)).toBe(`Promised ${formatINR(41712794, "full")} by 20 Nov 2026 (by voice)`);
  });

  it("adds (by voice, partial) to a partial voice promise", () => {
    expect(textOf({ ...PROMISE_BASE, amountPaise: 20000000, isPartial: true })).toBe(
      `Promised ${formatINR(20000000, "full")} by 20 Nov 2026 (by voice, partial)`,
    );
  });

  it("appends (replaced) once superseded on or before Today, and not before", () => {
    expect(textOf({ ...PROMISE_BASE, recordedOn: "2026-11-10", supersededOn: "2026-11-12" })).toBe(
      `Promised ${formatINR(41712794, "full")} by 20 Nov 2026 (by voice) (replaced)`,
    );
    expect(textOf({ ...PROMISE_BASE, recordedOn: "2026-11-10", supersededOn: "2026-11-13" })).toBe(
      `Promised ${formatINR(41712794, "full")} by 20 Nov 2026 (by voice)`,
    );
  });

  it("leaves a manual promise text unchanged, and adds (replaced) when it was replaced", () => {
    const manual = { ...PROMISE_BASE, source: "manual" as const };
    expect(textOf(manual)).toBe(`Promised ${formatINR(41712794, "full")} by 20 Nov 2026`);
    expect(textOf({ ...manual, supersededOn: "2026-11-12" })).toBe(
      `Promised ${formatINR(41712794, "full")} by 20 Nov 2026 (replaced)`,
    );
  });
});

function call(over: Partial<BuyerVoiceCall> = {}): BuyerVoiceCall {
  return {
    id: "call-1",
    invoiceId: "inv-sharma",
    callToday: "2026-11-12",
    status: "ended",
    startedAt: new Date("2026-11-12T06:00:00Z"),
    endedAt: new Date("2026-11-12T06:01:07Z"),
    durationSeconds: 67,
    outcome: "promise",
    transcript: [{ id: "tl-1", speaker: "buyer", text: "<b>haan</b>", receivedAt: new Date("2026-11-12T06:00:30Z") }],
    toolCalls: [
      {
        id: "tc-1",
        callId: "call_a",
        tool: "get_invoice_facts",
        arguments: "{}",
        result: { ok: true },
        createdAt: new Date("2026-11-12T06:00:10Z"),
      },
    ],
    ...over,
  };
}

describe("call entries (Req 9.4)", () => {
  const callsOf = (calls: BuyerVoiceCall[], promises: DebtorPromiseRow[] = []): TimelineEntry[] =>
    timelineFor(SHARMA_BUYER, [sharmaRecord()], [], promises, calls);

  it("shows an ended call as 'Voice call: <outcome>, m:ss' with its details", () => {
    expect(callsOf([call()]).filter((e) => e.kind === "call")).toEqual([
      {
        kind: "call",
        date: "2026-11-12",
        dateText: "12 Nov 2026",
        text: "Voice call: promise to pay, 1:07",
        invoiceNumber: "LPC/26-27/0412",
        rowId: "call-1",
        lit: true,
        tone: "spectral",
        call: {
          transcript: [{ id: "tl-1", speaker: "buyer", text: "<b>haan</b>" }],
          toolCalls: [{ id: "tc-1", tool: "get_invoice_facts", arguments: "{}", result: '{"ok":true}' }],
        },
      },
    ]);
  });

  it("uses the literal outcome texts", () => {
    expect(CALL_OUTCOME_TEXT).toEqual({
      promise: "promise to pay",
      dispute: "disputed",
      no_promise: "no promise",
      incomplete: "incomplete",
      consent_declined: "declined the AI call",
    });
  });

  it("formats durations as m:ss", () => {
    expect([0, 7, 60, 67, 300].map(formatDuration)).toEqual(["0:00", "0:07", "1:00", "1:07", "5:00"]);
  });

  it("excludes calls dated after Today, calls that have not ended, and calls of other invoices", () => {
    const entries = callsOf([
      call({ id: "future", callToday: "2026-11-13" }),
      call({ id: "live", status: "live", outcome: null, durationSeconds: null, endedAt: null }),
      call({ id: "foreign", invoiceId: "inv-other" }),
    ]);
    expect(entries.filter((e) => e.kind === "call")).toEqual([]);
  });

  it("puts a call before a promise on the same date", () => {
    const entries = callsOf([call()], [PROMISE_BASE]);
    expect(entries.filter((e) => e.date === "2026-11-12").map((e) => e.kind)).toEqual(["call", "promise"]);
  });
});
