import type { CalendarDate, EscalationEvent, EscalationHistory, Invoice, LadderStep, Paise } from "@dues-banshee/engine";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client";
import { toEngineInvoice } from "./invoices";
import type { EscalationAction } from "./ladder";
import { buyers, escalationEvents, invoices, promises, suppliers } from "./schema";

/**
 * One stored invoice as the dashboard needs it: the Engine `Invoice` plus the display fields the
 * Engine does not carry. There is no separate record id: `invoice.id` is the Invoice_Record id
 * used as the final sort tie-break (after invoice number).
 */
export interface GraveyardInvoiceRecord {
  /** `toEngineInvoice(invoiceRow, supplierRow)`. */
  invoice: Invoice;
  buyerName: string;
  invoiceNumber: string;
  /** Step events from `escalation_events` and promise events from `promises`. */
  history: EscalationHistory;
  /** `invoices.buyer_id`. */
  buyerId: string;
  /** `invoices.invoice_date`, the day the invoice was raised. */
  invoiceDate: CalendarDate;
}

/** One `escalation_events` row of any action, for the Debtor_Page timeline. */
export interface DebtorEventRow {
  id: string;
  invoiceId: string;
  step: LadderStep;
  action: EscalationAction;
  occurredOn: CalendarDate;
}

/** One `promises` row, for the Debtor_Page timeline. */
export interface DebtorPromiseRow {
  id: string;
  invoiceId: string;
  promisedDate: CalendarDate;
  amountPaise: Paise;
  recordedOn: CalendarDate;
}

/** Everything the Debtor_Page reads for one of the supplier's buyers. */
export interface DebtorData {
  buyer: { id: string; name: string };
  /** Same shape and history rules as `listGraveyardInvoices`, for this buyer's invoices only. */
  records: GraveyardInvoiceRecord[];
  /** Every action, not only `approved`. Ordered by `occurred_on`, then row id. */
  events: DebtorEventRow[];
  /** Ordered by `recorded_on`, then row id. */
  promises: DebtorPromiseRow[];
}

interface DatedEvent {
  /** Calendar_Date the event happened: step `occurred_on`, promise `recorded_on`. */
  date: string;
  /** Row id, the tie-break after `date`. */
  id: string;
  event: EscalationEvent;
}

function compareEvents(a: DatedEvent, b: DatedEvent): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * The three shared read-only queries behind `listGraveyardInvoices` and `getDebtorData`. Each is
 * filtered by `invoices.supplier_id = supplierId`, plus `invoices.buyer_id = buyerId` when given.
 * Returns the records (step events only from `approved` events) and the promise rows.
 */
async function readRecords(
  db: Db,
  supplierId: string,
  buyerId?: string,
): Promise<{ records: GraveyardInvoiceRecord[]; promiseRows: DebtorPromiseRow[] }> {
  const scope = (): ReturnType<typeof and> =>
    buyerId === undefined
      ? eq(invoices.supplierId, supplierId)
      : and(eq(invoices.supplierId, supplierId), eq(invoices.buyerId, buyerId));

  const invoiceRows = await db
    .select({ invoice: invoices, buyerName: buyers.name, supplier: suppliers })
    .from(invoices)
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(scope())
    .orderBy(asc(invoices.id));

  const stepRows = await db
    .select({
      id: escalationEvents.id,
      invoiceId: escalationEvents.invoiceId,
      step: escalationEvents.step,
      occurredOn: escalationEvents.occurredOn,
    })
    .from(escalationEvents)
    .innerJoin(invoices, eq(invoices.id, escalationEvents.invoiceId))
    // Only approved events are ladder steps; drafted, edited, rejected and expired are the audit trail.
    .where(and(scope(), eq(escalationEvents.action, "approved")))
    .orderBy(asc(escalationEvents.occurredOn), asc(escalationEvents.id));

  const promiseRows = await db
    .select({
      id: promises.id,
      invoiceId: promises.invoiceId,
      promisedDate: promises.promisedDate,
      amountPaise: promises.amountPaise,
      recordedOn: promises.recordedOn,
    })
    .from(promises)
    .innerJoin(invoices, eq(invoices.id, promises.invoiceId))
    .where(scope())
    .orderBy(asc(promises.recordedOn), asc(promises.id));

  const byInvoice = new Map<string, DatedEvent[]>();
  const push = (invoiceId: string, e: DatedEvent): void => {
    const list = byInvoice.get(invoiceId);
    if (list) list.push(e);
    else byInvoice.set(invoiceId, [e]);
  };
  for (const s of stepRows) {
    push(s.invoiceId, { date: s.occurredOn, id: s.id, event: { kind: "step", step: s.step, on: s.occurredOn } });
  }
  for (const p of promiseRows) {
    push(p.invoiceId, {
      date: p.recordedOn,
      id: p.id,
      event: {
        kind: "promise",
        promisedDate: p.promisedDate,
        amountPaise: p.amountPaise,
        recordedOn: p.recordedOn,
      },
    });
  }

  const records = invoiceRows.map((r) => ({
    invoice: toEngineInvoice(r.invoice, r.supplier),
    buyerName: r.buyerName,
    invoiceNumber: r.invoice.invoiceNumber,
    history: (byInvoice.get(r.invoice.id) ?? []).sort(compareEvents).map((e) => e.event),
    buyerId: r.invoice.buyerId,
    invoiceDate: r.invoice.invoiceDate,
  }));
  return { records, promiseRows };
}

/**
 * Reads everything the Graveyard needs for one supplier, with three read-only queries that are each
 * filtered by `invoices.supplier_id = supplierId`: invoices joined to buyers (on the composite
 * `(buyer_id, supplier_id)` key) and suppliers; `escalation_events` joined to invoices; `promises`
 * joined to invoices. Joining the event tables through `invoices.supplier_id` keeps other suppliers'
 * rows out. Each history lists step and promise events together, ordered by date then row id, so the
 * result is deterministic. Money stays integer paise. Returns `[]` for an unknown supplier.
 */
export async function listGraveyardInvoices(db: Db, supplierId: string): Promise<GraveyardInvoiceRecord[]> {
  return (await readRecords(db, supplierId)).records;
}

/**
 * Reads everything the Debtor_Page needs for one buyer. Read-only. The buyer is selected with
 * `buyers.id = buyerId AND buyers.supplier_id = supplierId`; no row (unknown id, or another
 * supplier's buyer) returns `null`. Records and promises come from the same supplier-scoped queries
 * as the Graveyard, narrowed to this buyer; `events` lists every action through a supplier-scoped
 * join on `invoices`.
 */
export async function getDebtorData(db: Db, supplierId: string, buyerId: string): Promise<DebtorData | null> {
  const [buyer] = await db
    .select({ id: buyers.id, name: buyers.name })
    .from(buyers)
    .where(and(eq(buyers.id, buyerId), eq(buyers.supplierId, supplierId)));
  if (!buyer) return null;

  const { records, promiseRows } = await readRecords(db, supplierId, buyerId);

  const events = await db
    .select({
      id: escalationEvents.id,
      invoiceId: escalationEvents.invoiceId,
      step: escalationEvents.step,
      action: escalationEvents.action,
      occurredOn: escalationEvents.occurredOn,
    })
    .from(escalationEvents)
    .innerJoin(invoices, eq(invoices.id, escalationEvents.invoiceId))
    .where(and(eq(invoices.supplierId, supplierId), eq(invoices.buyerId, buyerId)))
    .orderBy(asc(escalationEvents.occurredOn), asc(escalationEvents.id));

  return { buyer, records, events, promises: promiseRows };
}
