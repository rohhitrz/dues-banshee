import type { CalendarDate, Invoice, Paise } from "@dues-banshee/engine";
import type { DedupeKey, OkRow, StoredInvoiceFacts } from "@dues-banshee/ledger";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { buyers, invoices, suppliers, type InvoiceRow, type SupplierRow } from "./schema";

/** Rows per INSERT statement. 500 invoices × 11 columns stays far below Postgres's 65,535 parameters. */
const CHUNK_SIZE = 500;

/**
 * One invoice to write. There are deliberately no `supplierCategory` / `supplierActivity` fields:
 * `insertInvoiceRows` copies the Supplier_Snapshot from the supplier row, so no caller can set it
 * to anything else (Requirement 8.7).
 */
export interface InvoiceInsert {
  buyerId: string;
  invoiceNumber: string;
  invoiceNumberKey: string;
  invoiceDate: CalendarDate;
  acceptedOn: CalendarDate;
  acceptanceDateDefaulted: boolean;
  agreedTermDays?: number;
  amountPaise: Paise;
  /** Only the seed sets this; import never does. */
  paidOn?: CalendarDate;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The only code that writes `invoices`, shared by import and seed. Copies the Supplier_Snapshot
 * from `supplierRow`, skips rows whose Dedupe_Key already exists, and never updates a stored row.
 * Returns the number of rows actually inserted. Not exported from `index.ts`.
 */
export async function insertInvoiceRows(
  tx: Db,
  supplierRow: SupplierRow,
  rows: readonly InvoiceInsert[],
): Promise<number> {
  let inserted = 0;
  for (const chunk of chunks(rows, CHUNK_SIZE)) {
    const returned = await tx
      .insert(invoices)
      .values(
        chunk.map((r) => ({
          supplierId: supplierRow.id,
          buyerId: r.buyerId,
          invoiceNumber: r.invoiceNumber,
          invoiceNumberKey: r.invoiceNumberKey,
          invoiceDate: r.invoiceDate,
          acceptedOn: r.acceptedOn,
          acceptanceDateDefaulted: r.acceptanceDateDefaulted,
          agreedTermDays: r.agreedTermDays ?? null,
          amountPaise: r.amountPaise,
          paidOn: r.paidOn ?? null,
          supplierCategory: supplierRow.supplierCategory,
          supplierActivity: supplierRow.supplierActivity,
        })),
      )
      .onConflictDoNothing({ target: [invoices.supplierId, invoices.buyerId, invoices.invoiceNumberKey] })
      .returning({ id: invoices.id });
    inserted += returned.length;
  }
  return inserted;
}

/**
 * Inserts the buyers named in `names` (keyed by Buyer_Key, first-seen name wins) unless they
 * already exist, then returns every one of their ids by name key.
 */
export async function upsertBuyers(
  tx: Db,
  supplierId: string,
  names: ReadonlyMap<string /* name_key */, string /* name */>,
): Promise<Map<string, string>> {
  const entries = [...names];
  for (const chunk of chunks(entries, CHUNK_SIZE)) {
    await tx
      .insert(buyers)
      .values(chunk.map(([nameKey, name]) => ({ supplierId, name, nameKey })))
      .onConflictDoNothing({ target: [buyers.supplierId, buyers.nameKey] });
  }
  const ids = new Map<string, string>();
  for (const chunk of chunks(entries, CHUNK_SIZE)) {
    const found = await tx
      .select({ id: buyers.id, nameKey: buyers.nameKey })
      .from(buyers)
      .where(
        and(
          eq(buyers.supplierId, supplierId),
          inArray(
            buyers.nameKey,
            chunk.map(([nameKey]) => nameKey),
          ),
        ),
      );
    for (const b of found) ids.set(b.nameKey, b.id);
  }
  return ids;
}

function assertSupplier(supplierId: string, keys: Iterable<DedupeKey>, fn: string): void {
  for (const key of keys) {
    if (key.supplierId !== supplierId) {
      throw new Error(`${fn}: dedupe key ${key.value} belongs to supplier ${key.supplierId}, not ${supplierId}`);
    }
  }
}

/**
 * Writes the `ok` rows of an import in one transaction (Requirement 10.1–10.4): inserts missing
 * buyers and invoices, skips invoices whose Dedupe_Key is already stored, and updates or deletes
 * nothing. Any error other than an existing Dedupe_Key rolls the whole import back.
 */
export async function importInvoices(
  db: Db,
  supplierId: string,
  rows: readonly OkRow[],
): Promise<{ inserted: number; skipped: number }> {
  assertSupplier(
    supplierId,
    rows.map((r) => r.dedupeKey),
    "importInvoices",
  );
  return db.transaction(async (tx) => {
    const [supplierRow] = await tx.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
    if (!supplierRow) throw new Error(`importInvoices: supplier ${supplierId} not found`);

    const names = new Map<string, string>();
    for (const r of rows) {
      if (!names.has(r.dedupeKey.buyerKey)) names.set(r.dedupeKey.buyerKey, r.buyerName);
    }
    const buyerIds = await upsertBuyers(tx, supplierId, names);

    const inserts = rows.map((r): InvoiceInsert => {
      const buyerId = buyerIds.get(r.dedupeKey.buyerKey);
      if (buyerId === undefined) throw new Error(`importInvoices: no buyer id for ${r.dedupeKey.buyerKey}`);
      return {
        buyerId,
        invoiceNumber: r.invoiceNumber,
        invoiceNumberKey: r.dedupeKey.invoiceNumberKey,
        invoiceDate: r.invoiceDate,
        acceptedOn: r.invoice.acceptedOn,
        acceptanceDateDefaulted: r.acceptanceDateDefaulted,
        ...(r.invoice.agreedTermDays === undefined ? {} : { agreedTermDays: r.invoice.agreedTermDays }),
        amountPaise: r.invoice.amountPaise,
      };
    });
    const inserted = await insertInvoiceRows(tx, supplierRow, inserts);
    return { inserted, skipped: rows.length - inserted };
  });
}

/**
 * For each key already stored for `supplierId`, returns the stored amount and dates, keyed by
 * `DedupeKey.value` (Requirement 10.5). One query; an empty `keys` returns an empty map without
 * touching the database.
 */
export async function findStoredInvoices(
  db: Db,
  supplierId: string,
  keys: readonly DedupeKey[],
): Promise<Map<string, StoredInvoiceFacts>> {
  const result = new Map<string, StoredInvoiceFacts>();
  if (keys.length === 0) return result;
  assertSupplier(supplierId, keys, "findStoredInvoices");

  // (buyerKey, invoiceNumberKey) → DedupeKey.value, so the map is keyed exactly as the caller's keys.
  const byPair = new Map<string, string>();
  for (const k of keys) byPair.set(JSON.stringify([k.buyerKey, k.invoiceNumberKey]), k.value);
  const buyerKeys = keys.map((k) => k.buyerKey);
  const numberKeys = keys.map((k) => k.invoiceNumberKey);

  const found = await db
    .select({
      nameKey: buyers.nameKey,
      invoiceNumberKey: invoices.invoiceNumberKey,
      amountPaise: invoices.amountPaise,
      invoiceDate: invoices.invoiceDate,
      acceptedOn: invoices.acceptedOn,
    })
    .from(invoices)
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .where(
      and(
        eq(invoices.supplierId, supplierId),
        sql`(${buyers.nameKey}, ${invoices.invoiceNumberKey}) in (select * from unnest(${sql.param(buyerKeys)}::text[], ${sql.param(numberKeys)}::text[]))`,
      ),
    );

  for (const f of found) {
    const value = byPair.get(JSON.stringify([f.nameKey, f.invoiceNumberKey]));
    if (value === undefined) continue;
    result.set(value, { amountPaise: f.amountPaise, invoiceDate: f.invoiceDate, acceptedOn: f.acceptedOn });
  }
  return result;
}

/**
 * Builds an Engine `Invoice` from a stored invoice and its supplier (Requirement 8.8). Category and
 * activity come from the invoice's Supplier_Snapshot, `udyamRegisteredOn` from the supplier. Null
 * optionals are omitted. Computes nothing.
 */
export function toEngineInvoice(invoice: InvoiceRow, supplier: SupplierRow): Invoice {
  return {
    id: invoice.id,
    amountPaise: invoice.amountPaise,
    acceptedOn: invoice.acceptedOn,
    ...(invoice.agreedTermDays === null ? {} : { agreedTermDays: invoice.agreedTermDays }),
    supplierCategory: invoice.supplierCategory,
    supplierActivity: invoice.supplierActivity,
    ...(supplier.udyamRegisteredOn === null ? {} : { udyamRegisteredOn: supplier.udyamRegisteredOn }),
    ...(invoice.paidOn === null ? {} : { paidOn: invoice.paidOn }),
  };
}
