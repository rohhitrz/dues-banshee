import type { EscalationHistory, Invoice } from "@dues-banshee/engine";

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
