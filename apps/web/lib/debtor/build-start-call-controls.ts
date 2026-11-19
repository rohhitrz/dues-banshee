import type { CalendarDate } from "@dues-banshee/engine";
import type { TombstoneState } from "../graveyard/labels";
import { isCallableInvoice, isDemoSupplier } from "../call/callable";

/**
 * Everything StartCallControls needs for one invoice. Booleans and ids only: the API key never leaves the
 * server, only whether it is set.
 */
export interface StartCallControlsData {
  invoiceId: string;
  /** The invoice is a Callable_Invoice on Today. */
  callable: boolean;
  /** `OPENAI_API_KEY` is set and not empty. */
  configured: boolean;
  /** The Session_Supplier is the Demo_Supplier. */
  isDemo: boolean;
  /** The Demo_Override, sent back as the hidden `today` field; null for every other supplier. */
  override: CalendarDate | null;
}

export interface BuildStartCallControlsInput {
  tombstone: { id: string; state: TombstoneState; dueDate: CalendarDate | null };
  supplier: { udyamNumber: string };
  today: CalendarDate;
  override: CalendarDate | null;
  env: Readonly<Record<string, string | undefined>>;
}

/** Pure: reads the Tombstone fields the Graveyard_Builder produced; does no legal or money maths. */
export function buildStartCallControls({
  tombstone,
  supplier,
  today,
  override,
  env,
}: BuildStartCallControlsInput): StartCallControlsData {
  return {
    invoiceId: tombstone.id,
    callable: isCallableInvoice(tombstone, today),
    configured: (env.OPENAI_API_KEY ?? "") !== "",
    isDemo: isDemoSupplier(supplier),
    override,
  };
}
