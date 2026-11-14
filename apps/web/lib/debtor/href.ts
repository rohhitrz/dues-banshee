import type { CalendarDate } from "@dues-banshee/engine";

/**
 * Link from a dashboard Tombstone to the Debtor_Page. The Demo_Override, when active, goes before the
 * fragment so the debtor page shows the same Today as the graveyard. Both ids are uuids, so nothing needs escaping.
 */
export function debtorHref(buyerId: string, invoiceId: string, override: CalendarDate | null): string {
  const query = override === null ? "" : `?today=${override}`;
  return `/debtors/${buyerId}${query}#invoice-${invoiceId}`;
}
