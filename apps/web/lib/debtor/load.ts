import {
  BankRateNotFoundError,
  SupplierNotFoundError,
  getBankRate,
  getDebtorData,
  getSupplier,
  listPendingDrafts,
  type Db,
} from "@dues-banshee/db";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";
import { resolveSupplierToday } from "../approvals/supplier-today";
import { buildDebtorView, type DebtorView } from "./build-debtor-view";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DebtorLoadResult =
  | { kind: "ok"; view: DebtorView }
  /** The session's supplier no longer exists. The page redirects, outside any `try`. */
  | { kind: "stale" }
  /** Non-uuid id, unknown buyer, or another supplier's buyer. All look the same to the caller. */
  | { kind: "not_found" }
  /**
   * Any other failure. Carries no error data; details go to `console.error` only.
   * `override` is the Demo_Override when it had already been resolved, else null.
   */
  | { kind: "error"; override: CalendarDate | null };

/**
 * Loads one buyer's Debtor_View. Never throws and never calls `redirect()` or `notFound()`.
 * Order: supplier (stale before any id check) → Today → uuid check (no buyer query for a non-uuid) →
 * Bank_Rate (`BankRateNotFoundError` → null) → buyer data (`null` → not_found) → pending Drafts → view.
 */
export async function loadDebtorData(
  db: Db,
  supplierId: string,
  buyerIdRaw: string,
  nowMs: number,
  rawToday: string | string[] | undefined,
): Promise<DebtorLoadResult> {
  let override: CalendarDate | null = null;
  try {
    const supplier = await getSupplier(db, supplierId);
    const resolved = resolveSupplierToday(supplier, nowMs, rawToday);
    const { today } = resolved;
    override = resolved.override;

    if (!UUID.test(buyerIdRaw)) return { kind: "not_found" };

    let bankRate: BankRate | null;
    try {
      bankRate = await getBankRate(db, today);
    } catch (err) {
      if (!(err instanceof BankRateNotFoundError)) throw err;
      bankRate = null;
    }

    const data = await getDebtorData(db, supplierId, buyerIdRaw);
    if (data === null) return { kind: "not_found" };

    const drafts = await listPendingDrafts(db, supplierId);
    const view = buildDebtorView({ supplier, data, bankRate, drafts, today, override });
    return { kind: "ok", view };
  } catch (err) {
    if (err instanceof SupplierNotFoundError) return { kind: "stale" };
    console.error("loadDebtorData failed", err);
    return { kind: "error", override };
  }
}
