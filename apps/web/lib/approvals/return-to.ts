/** Where an approvals action sends the owner back to: the queue, or one buyer's Debtor_Page. */
export type ReturnTarget = "/approvals" | `/debtors/${string}`;

const DEFAULT_TARGET = "/approvals";
const DEBTOR_TARGET = /^\/debtors\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The form's `returnTo` is untrusted. Only `/approvals` and `/debtors/<uuid>` (nothing before or after)
 * are followed; anything else, including absolute and protocol-relative URLs, goes to `/approvals`.
 */
export function parseReturnTo(raw: string): ReturnTarget {
  if (raw === DEFAULT_TARGET) return DEFAULT_TARGET;
  return DEBTOR_TARGET.test(raw) ? (raw as `/debtors/${string}`) : DEFAULT_TARGET;
}
