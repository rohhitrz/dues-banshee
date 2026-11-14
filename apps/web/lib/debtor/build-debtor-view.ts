import type { DebtorData, DraftWithContext, Supplier } from "@dues-banshee/db";
import { activePromiseUntil, type BankRate, type CalendarDate } from "@dues-banshee/engine";
import { buildGraveyard, type TombstoneView } from "../graveyard/build-graveyard";
import { overdueText } from "../graveyard/labels";
import { formatDisplayDate } from "../graveyard/today";
import { buildCandleTimeline, type TimelineEntry } from "./candle-timeline";

export interface InvoicePanelView {
  /** From `buildGraveyard`, unchanged. */
  tombstone: TombstoneView;
  buyerId: string;
  panelId: `invoice-${string}`;
  /** Same rule as the Tombstone: `labels.overdueText`. */
  overdueText: string | null;
  /** "Promise to pay active until <D MMM YYYY>", or null. */
  promiseUntilText: string | null;
  /** True iff the invoice is not resurrected. */
  showPlaceholders: boolean;
}

export interface DebtorView {
  supplierName: string;
  buyerId: string;
  buyerName: string;
  today: CalendarDate;
  override: CalendarDate | null;
  /** Graveyard order. */
  panels: InvoicePanelView[];
  timeline: TimelineEntry[];
  /** This buyer's pending Drafts, in the order of the input list. */
  drafts: DraftWithContext[];
}

export interface BuildDebtorViewInput {
  supplier: Supplier;
  data: DebtorData;
  bankRate: BankRate | null;
  drafts: readonly DraftWithContext[];
  today: CalendarDate;
  override: CalendarDate | null;
}

/**
 * Builds the Debtor_View. Pure: no I/O, no clock, inputs are never mutated. Every legal figure comes from
 * the Graveyard_Builder (and so the Engine); this function only selects, formats and orders.
 */
export function buildDebtorView({
  supplier,
  data,
  bankRate,
  drafts,
  today,
  override,
}: BuildDebtorViewInput): DebtorView {
  const tombstones = buildGraveyard(supplier, data.records, bankRate, today).tombstones;
  const historyByInvoice = new Map(data.records.map((r) => [r.invoice.id, r.history]));

  const panels: InvoicePanelView[] = tombstones.map((tombstone) => {
    const resurrected = tombstone.state === "resurrected";
    const history = historyByInvoice.get(tombstone.id);
    const until = resurrected || history === undefined ? null : activePromiseUntil(history, today);
    return {
      tombstone,
      buyerId: data.buyer.id,
      panelId: `invoice-${tombstone.id}`,
      overdueText: overdueText(tombstone),
      promiseUntilText: until === null ? null : `Promise to pay active until ${formatDisplayDate(until)}`,
      showPlaceholders: !resurrected,
    };
  });

  const panelInvoiceIds = new Set(tombstones.map((t) => t.id));

  return {
    supplierName: supplier.name,
    buyerId: data.buyer.id,
    buyerName: data.buyer.name,
    today,
    override,
    panels,
    timeline: buildCandleTimeline({
      panels,
      records: data.records,
      events: data.events,
      promises: data.promises,
      today,
    }),
    drafts: drafts.filter((d) => d.buyerId === data.buyer.id && panelInvoiceIds.has(d.invoice.id)),
  };
}
