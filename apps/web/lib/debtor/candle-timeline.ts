import type {
  BuyerVoiceCall,
  DebtorEventRow,
  DebtorPromiseRow,
  EscalationAction,
  GraveyardInvoiceRecord,
  VoiceCallOutcome as CallOutcome,
} from "@dues-banshee/db";
import { formatDisplayDate, formatINR, type CalendarDate } from "@dues-banshee/engine";
import { STEP_TEXT } from "../graveyard/labels";
import type { InvoicePanelView } from "./build-debtor-view";

export type EntryKind = "invoice" | "due" | "ladder" | "call" | "promise" | "payment";

/** What a `call` entry shows inside its closed `<details>`. Plain text only: React escapes it on render. */
export interface CallDetails {
  transcript: { id: string; speaker: "buyer" | "agent"; text: string }[];
  toolCalls: { id: string; tool: string; arguments: string; result: string }[];
}

export interface TimelineEntry {
  kind: EntryKind;
  date: CalendarDate;
  dateText: string;
  text: string;
  invoiceNumber: string;
  rowId: string;
  lit: boolean;
  tone: "bone" | "spectral" | "ember";
  /** Set on `call` entries only. */
  call?: CallDetails;
}

export interface CandleTimelineInput {
  panels: readonly InvoicePanelView[];
  records: readonly GraveyardInvoiceRecord[];
  events: readonly DebtorEventRow[];
  promises: readonly DebtorPromiseRow[];
  calls: readonly BuyerVoiceCall[];
  today: CalendarDate;
}

export const ACTION_TEXT = {
  drafted: "drafted",
  edited: "edited",
  approved: "approved",
  rejected: "rejected",
  expired: "expired",
  sent: "sent",
} as const satisfies Record<EscalationAction, string>;

export const CALL_OUTCOME_TEXT = {
  promise: "promise to pay",
  dispute: "disputed",
  no_promise: "no promise",
  incomplete: "incomplete",
  consent_declined: "declined the AI call",
} as const satisfies Record<CallOutcome, string>;

const KIND_RANK: Record<EntryKind, number> = { invoice: 0, due: 1, ladder: 2, call: 3, promise: 4, payment: 5 };

/**
 * Whole seconds as `m:ss` ("0:07", "5:00"). A call lasts at most 300 s (the database caps it), so the
 * clamp below is never reached in practice. Formatting only: it takes `mm:ss` from an ISO time string.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.min(3599, Math.max(0, Math.trunc(totalSeconds)));
  const mmss = new Date(s * 1000).toISOString().slice(14, 19);
  return mmss.startsWith("0") ? mmss.slice(1) : mmss;
}

/** The suffixes of a promise entry (Req 9 C3): voice, voice + partial, and replaced on or before Today. */
function promiseText(p: DebtorPromiseRow, today: CalendarDate): string {
  let text = `Promised ${formatINR(p.amountPaise, "full")} by ${formatDisplayDate(p.promisedDate)}`;
  if (p.source === "voice") text += p.isPartial ? " (by voice, partial)" : " (by voice)";
  if (p.supersededOn !== null && p.supersededOn <= today) text += " (replaced)";
  return text;
}

/** Code-unit comparison, never locale-aware. */
function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareEntries(a: TimelineEntry, b: TimelineEntry): number {
  return cmp(a.date, b.date) || cmp(KIND_RANK[a.kind], KIND_RANK[b.kind]) || cmp(a.rowId, b.rowId);
}

/**
 * Builds the Candle_Timeline. Pure: no I/O, no clock, inputs are never mutated, and the output does not
 * depend on input order. Only Debtor_Invoices (those with a panel) contribute entries. Amounts and dates are
 * formatted from the stored values; nothing is recomputed.
 */
export function buildCandleTimeline({
  panels,
  records,
  events,
  promises,
  calls,
  today,
}: CandleTimelineInput): TimelineEntry[] {
  const panelByInvoice = new Map(panels.map((p) => [p.tombstone.id, p]));
  const recordByInvoice = new Map(records.map((r) => [r.invoice.id, r]));

  const entry = (
    kind: EntryKind,
    date: CalendarDate,
    text: string,
    invoiceNumber: string,
    rowId: string,
    tone: TimelineEntry["tone"],
    call?: CallDetails,
  ): TimelineEntry => ({
    kind,
    date,
    dateText: formatDisplayDate(date),
    text,
    invoiceNumber,
    rowId,
    lit: date <= today,
    tone,
    ...(call === undefined ? {} : { call }),
  });

  const out: TimelineEntry[] = [];

  for (const panel of panels) {
    const t = panel.tombstone;
    const record = recordByInvoice.get(t.id);
    if (record === undefined) continue;

    out.push(
      entry("invoice", record.invoiceDate, `Invoice ${t.invoiceNumber} raised for ${t.principalText}`, t.invoiceNumber, t.id, "bone"),
    );

    if (t.dueDate !== null) {
      const ember = today > t.dueDate && t.state !== "resurrected";
      out.push(entry("due", t.dueDate, "Due date (MSMED-15)", t.invoiceNumber, t.id, ember ? "ember" : "bone"));
    }

    const paidOn = record.invoice.paidOn;
    if (paidOn !== undefined && paidOn <= today) {
      out.push(entry("payment", paidOn, "Paid. Resurrected", t.invoiceNumber, t.id, "spectral"));
    }
  }

  for (const e of events) {
    const panel = panelByInvoice.get(e.invoiceId);
    if (panel === undefined || e.occurredOn > today) continue;
    out.push(
      entry(
        "ladder",
        e.occurredOn,
        `${STEP_TEXT[e.step]} ${ACTION_TEXT[e.action]}`,
        panel.tombstone.invoiceNumber,
        e.id,
        "bone",
      ),
    );
  }

  for (const p of promises) {
    const panel = panelByInvoice.get(p.invoiceId);
    if (panel === undefined || p.recordedOn > today) continue;
    out.push(
      entry(
        "promise",
        p.recordedOn,
        promiseText(p, today),
        panel.tombstone.invoiceNumber,
        p.id,
        "spectral",
      ),
    );
  }

  for (const c of calls) {
    const panel = panelByInvoice.get(c.invoiceId);
    if (panel === undefined || c.status !== "ended" || c.outcome === null || c.durationSeconds === null) continue;
    if (c.callToday > today) continue;
    out.push(
      entry(
        "call",
        c.callToday,
        `Voice call: ${CALL_OUTCOME_TEXT[c.outcome]}, ${formatDuration(c.durationSeconds)}`,
        panel.tombstone.invoiceNumber,
        c.id,
        c.outcome === "promise" ? "spectral" : "bone",
        {
          transcript: c.transcript.map((l) => ({ id: l.id, speaker: l.speaker, text: l.text })),
          toolCalls: c.toolCalls.map((t) => ({
            id: t.id,
            tool: t.tool,
            arguments: t.arguments,
            result: JSON.stringify(t.result) ?? "",
          })),
        },
      ),
    );
  }

  return out.sort(compareEntries);
}
