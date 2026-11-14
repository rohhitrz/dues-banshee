import { DEMO_SUPPLIER } from "@dues-banshee/db";
import { istDate, resolveToday, type ResolvedToday } from "@/lib/graveyard/today";
/**
 * Today for the approvals page and its actions. A `today` override is honoured only for the demo
 * supplier, the same rule as `/api/ladder/run`; every other supplier gets the real IST date and no override.
 */
export function resolveSupplierToday(
  supplier: { udyamNumber: string },
  nowMs: number,
  raw: string | string[] | undefined,
): ResolvedToday {
  if (supplier.udyamNumber === DEMO_SUPPLIER.udyamNumber) return resolveToday(nowMs, raw);
  return { today: istDate(nowMs), override: null };
}
