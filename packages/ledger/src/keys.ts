import type { DedupeKey } from "./types";

/**
 * Header_Key: a header cell normalised for matching. NFKC, lowercased, every
 * character other than a-z and 0-9 removed ("Party's Name" -> "partysname").
 */
export const headerKey = (s: string): string =>
  s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Text_Key: a value normalised for deduplication. NFKC, trimmed, whitespace
 * runs collapsed to one space, lowercased. Punctuation is kept, so `INV/001`
 * and `INV-001` stay different.
 */
export const textKey = (s: string): string =>
  s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Dedupe_Key for one invoice. `value` is JSON, so no character in a buyer name
 * or invoice number can make two different keys collide.
 */
export function dedupeKey(
  supplierId: string,
  buyerName: string,
  invoiceNumber: string,
): DedupeKey {
  const buyerKey = textKey(buyerName);
  const invoiceNumberKey = textKey(invoiceNumber);
  return {
    supplierId,
    buyerKey,
    invoiceNumberKey,
    value: JSON.stringify([supplierId, buyerKey, invoiceNumberKey]),
  };
}
