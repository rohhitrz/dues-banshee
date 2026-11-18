import { readChannelEnv } from "@dues-banshee/agent";
import {
  BankRateNotFoundError,
  SupplierNotFoundError,
  getBankRate,
  getDebtorData,
  getSupplier,
  listPendingDrafts,
  listSendState,
  type Db,
} from "@dues-banshee/db";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";
import { resolveSupplierToday } from "../approvals/supplier-today";
import { buildDebtorView, type DebtorView } from "./build-debtor-view";
import { buildSendControls, type SendControlsData } from "./build-send-controls";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DebtorLoadResult =
  /** `send` holds the send controls data of each invoice, keyed by invoice id. Booleans and text only. */
  | { kind: "ok"; view: DebtorView; send: Record<string, SendControlsData> }
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
 * Bank_Rate (`BankRateNotFoundError` → null) → buyer data (`null` → not_found) → pending Drafts → send state
 * → view. Only the `twilioReady` boolean is taken from the Channel_Env; no secret reaches the result.
 */
export async function loadDebtorData(
  db: Db,
  supplierId: string,
  buyerIdRaw: string,
  nowMs: number,
  rawToday: string | string[] | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
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
    const sendState = await listSendState(db, supplierId, buyerIdRaw);
    const twilioReady = readChannelEnv(env).twilio !== null;
    const view = buildDebtorView({ supplier, data, bankRate, drafts, today, override });
    const stateByInvoice = new Map(sendState.invoices.map((s) => [s.invoiceId, s]));
    const send: Record<string, SendControlsData> = {};
    for (const panel of view.panels) {
      const state = stateByInvoice.get(panel.tombstone.id);
      if (state === undefined) continue;
      send[panel.tombstone.id] = buildSendControls({
        state,
        amountPaise: panel.tombstone.principalPaise,
        buyerNumberSet: sendState.buyerHasNumber,
        twilioReady,
        override,
      });
    }
    return { kind: "ok", view, send };
  } catch (err) {
    if (err instanceof SupplierNotFoundError) return { kind: "stale" };
    console.error("loadDebtorData failed", err);
    return { kind: "error", override };
  }
}
