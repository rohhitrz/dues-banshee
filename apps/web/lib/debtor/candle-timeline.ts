import type {
  DebtorEventRow,
  DebtorPromiseRow,
  EscalationAction,
  GraveyardInvoiceRecord,
} from "@dues-banshee/db";
import { formatDisplayDate, formatINR, type CalendarDate } from "@dues-banshee/engine";
import { STEP_TEXT } from "../graveyard/labels";
import type { InvoicePanelView } from "./build-debtor-view";

export type EntryKind = "invoice" | "due" | "ladder" | "promise" | "payment";

export interface TimelineEntry {
  kind: EntryKind;
  date: CalendarDate;
  dateText: string;
  text: string;
  invoiceNumber: string;
  rowId: string;
  lit: boolean;
  tone: "bone" | "spectral" | "ember";
}

export interface CandleTimelineInput {
  panels: readonly InvoicePanelView[];
  records: readonly GraveyardInvoiceRecord[];
  events: readonly DebtorEventRow[];
  promises: readonly DebtorPromiseRow[];
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

const KIND_RANK: Record<EntryKind, number> = { invoice: 0, due: 1, ladder: 2, promise: 3, payment: 4 };

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
  ): TimelineEntry => ({
    kind,
    date,
    dateText: formatDisplayDate(date),
    text,
    invoiceNumber,
    rowId,
    lit: date <= today,
    tone,
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
        `Promised ${formatINR(p.amountPaise, "full")} by ${formatDisplayDate(p.promisedDate)}`,
        panel.tombstone.invoiceNumber,
        p.id,
        "spectral",
      ),
    );
  }

  return out.sort(compareEntries);
}
