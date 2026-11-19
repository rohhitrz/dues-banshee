import { DEMO_SUPPLIER } from "@dues-banshee/db";
import type { CalendarDate } from "@dues-banshee/engine";
import type { TombstoneState } from "../graveyard/labels";
import { NOT_CALLABLE_TEXT, NOT_CONFIGURED_TEXT } from "./call-copy";

/** Demo_Call_Limit: Voice_Calls of the Demo_Supplier that may start on one Call_Day. */
export const DEMO_CALL_LIMIT = 20;

/**
 * Callable_Invoice: unpaid on Today, has an Engine due date, is after that due date on Today, and is not
 * `not_covered`. Reads the Tombstone fields the Graveyard_Builder already took from the Engine; it does no
 * legal or money maths of its own.
 */
export function isCallableInvoice(
  tombstone: { state: TombstoneState; dueDate: CalendarDate | null },
  today: CalendarDate,
): boolean {
  if (tombstone.state === "resurrected" || tombstone.state === "not_covered") return false;
  return tombstone.dueDate !== null && today > tombstone.dueDate;
}

/** The Demo_Supplier is identified by its Udyam number. */
export function isDemoSupplier(supplier: { udyamNumber: string }): boolean {
  return supplier.udyamNumber === DEMO_SUPPLIER.udyamNumber;
}

export type StartCallRefusalKind =
  | "not_found"
  | "not_configured"
  | "not_callable"
  | "outside_window"
  | "already_called"
  | "demo_limit";

export const REFUSAL_TEXT: Record<StartCallRefusalKind, string> = {
  not_found: "Invoice not found",
  not_configured: NOT_CONFIGURED_TEXT,
  not_callable: NOT_CALLABLE_TEXT,
  outside_window: "Calls are allowed 10:00–19:00 IST, Monday to Saturday",
  already_called: "This buyer was already called today",
  demo_limit: "Demo call limit reached for today",
};

export interface StartCallRefusalInput {
  /** The invoice id resolved to an invoice of the Session_Supplier. */
  found: boolean;
  /** `OPENAI_API_KEY` is set and not empty. */
  configured: boolean;
  callable: boolean;
  isDemo: boolean;
  /** `inCallWindow` of the real clock instant (never the Demo_Override). */
  inWindow: boolean;
  /** The buyer's Voice_Calls whose `started_at` falls on the Call_Day. */
  buyerCallsToday: number;
  /** The Demo_Supplier's Voice_Calls whose `started_at` falls on the Call_Day. */
  demoCallsToday: number;
}

/**
 * The first refusal that applies, in the order of Req 1 C13: not found, not configured, not callable, then
 * for a non-demo supplier outside the Call_Window and buyer already called; for the Demo_Supplier the
 * Demo_Call_Limit only. `null` when the call may start.
 */
export function startCallRefusal(input: StartCallRefusalInput): StartCallRefusalKind | null {
  if (!input.found) return "not_found";
  if (!input.configured) return "not_configured";
  if (!input.callable) return "not_callable";
  if (input.isDemo) return input.demoCallsToday >= DEMO_CALL_LIMIT ? "demo_limit" : null;
  if (!input.inWindow) return "outside_window";
  if (input.buyerCallsToday > 0) return "already_called";
  return null;
}
