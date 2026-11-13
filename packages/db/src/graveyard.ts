import type { EscalationEvent, EscalationHistory, Invoice } from "@dues-banshee/engine";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./client";
import { toEngineInvoice } from "./invoices";
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
 * Reads everything the Graveyard needs for one supplier, with three read-only queries that are each
 * filtered by `invoices.supplier_id = supplierId`: invoices joined to buyers (on the composite
 * `(buyer_id, supplier_id)` key) and suppliers; `escalation_events` joined to invoices; `promises`
 * joined to invoices. Joining the event tables through `invoices.supplier_id` keeps other suppliers'
 * rows out. Each history lists step and promise events together, ordered by date then row id, so the
 * result is deterministic. Money stays integer paise. Returns `[]` for an unknown supplier.
 */
export async function listGraveyardInvoices(db: Db, supplierId: string): Promise<GraveyardInvoiceRecord[]> {
  const invoiceRows = await db
    .select({ invoice: invoices, buyerName: buyers.name, supplier: suppliers })
    .from(invoices)
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(eq(invoices.supplierId, supplierId))
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
    .where(eq(invoices.supplierId, supplierId))
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
    .where(eq(invoices.supplierId, supplierId))
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

  return invoiceRows.map((r) => ({
    invoice: toEngineInvoice(r.invoice, r.supplier),
    buyerName: r.buyerName,
    invoiceNumber: r.invoice.invoiceNumber,
    history: (byInvoice.get(r.invoice.id) ?? []).sort(compareEvents).map((e) => e.event),
  }));
}
