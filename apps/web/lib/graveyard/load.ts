import {
  BankRateNotFoundError,
  SupplierNotFoundError,
  getBankRate,
  getSupplier,
  listGraveyardInvoices,
  type Db,
  type GraveyardInvoiceRecord,
  type Supplier,
} from "@dues-banshee/db";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";
import { buildGraveyard, type GraveyardView } from "./build-graveyard";

export type GraveyardLoadResult =
  | {
      kind: "ok";
      supplier: Supplier;
      /** null when no Bank_Rate is effective on Today. */
      bankRate: BankRate | null;
      records: GraveyardInvoiceRecord[];
      /** `buildGraveyard(supplier, records, bankRate, today)`; the page renders this and does not build again. */
      view: GraveyardView;
    }
  /** The session's supplier no longer exists. The page redirects, outside any `try`. */
  | { kind: "stale" }
  /** Any other failure. Carries no error data; details go to `console.error` only. */
  | { kind: "error" };

/**
 * Loads one supplier's graveyard and builds its view. Never throws and never calls `redirect()`.
 * - `SupplierNotFoundError` (instanceof) → `stale`.
 * - `BankRateNotFoundError` from `getBankRate` → `bankRate: null`, result stays `ok`.
 * - Any other error, including an Engine `ValidationError` thrown while building → `error`.
 */
export async function loadGraveyardData(
  db: Db,
  supplierId: string,
  today: CalendarDate,
): Promise<GraveyardLoadResult> {
  try {
    const supplier = await getSupplier(db, supplierId);
    let bankRate: BankRate | null;
    try {
      bankRate = await getBankRate(db, today);
    } catch (err) {
      if (!(err instanceof BankRateNotFoundError)) throw err;
      bankRate = null;
    }
    const records = await listGraveyardInvoices(db, supplierId, today);
    const view = buildGraveyard(supplier, records, bankRate, today);
    return { kind: "ok", supplier, bankRate, records, view };
  } catch (err) {
    if (err instanceof SupplierNotFoundError) return { kind: "stale" };
    console.error("loadGraveyardData failed", err);
    return { kind: "error" };
  }
}
