import type { OkRow, StoredInvoiceFacts } from "./types";

/**
 * Compares a file row with the invoice already stored under the same
 * Dedupe_Key. Returns null when equal, otherwise a warning listing the
 * differing fields in the order amount, invoice date, accepted date.
 */
export function compareWithStored(row: OkRow, stored: StoredInvoiceFacts): string | null {
  const differing: string[] = [];
  if (row.invoice.amountPaise !== stored.amountPaise) differing.push("amount");
  if (row.invoiceDate !== stored.invoiceDate) differing.push("invoice date");
  if (row.invoice.acceptedOn !== stored.acceptedOn) differing.push("accepted date");
  if (differing.length === 0) return null;
  return `Differs from stored invoice: ${differing.join(", ")}`;
}
