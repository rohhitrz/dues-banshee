import type { CalendarDate, Paise } from "@dues-banshee/engine";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client";
import { buyers, invoices, paymentLinks, suppliers, webhookEvents } from "./schema";

/** The providers whose webhook deliveries are de-duplicated in `webhook_events`. */
export type WebhookProvider = "razorpay" | "twilio";

/** A stored Pay_Link with the invoice, buyer and supplier it belongs to, as the Razorpay webhook needs them. */
export interface PayLinkMatch {
  /** `payment_links.id` (the row id, not the Razorpay id). */
  payLinkId: string;
  providerLinkId: string;
  /** Pay_Amount: the amount the link was created for. */
  amountPaise: Paise;
  /** `payment_links.status`: `created` or `paid`. */
  status: string;
  /** Today in effect when the link was created; null for rows from before migration 0003. */
  createdOn: CalendarDate | null;
  invoiceId: string;
  /** `invoices.paid_on`: non-null when the invoice is already paid. */
  paidOn: CalendarDate | null;
  buyerId: string;
  supplierId: string;
}

/**
 * Records a provider event id as processed. Returns `true` when this call inserted the row and
 * `false` when the (provider, event id) pair already existed. Run it as the first statement of the
 * webhook transaction: a concurrent delivery of the same id waits on the unique key and then
 * inserts nothing, so only one of them sees `true`. Pass the transaction handle as `tx`.
 */
export async function recordWebhookEvent(tx: Db, provider: WebhookProvider, eventId: string): Promise<boolean> {
  const rows = await tx
    .insert(webhookEvents)
    .values({ provider, eventId })
    .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] })
    .returning({ id: webhookEvents.id });
  return rows.length > 0;
}

/**
 * Finds the stored Pay_Link whose Razorpay id is `providerLinkId`, joined to its invoice, buyer and
 * supplier. Returns `null` when no stored link has that id. The id comes from a signature-verified
 * payload, and the webhook has no session, so the supplier is read from the row, not filtered on.
 */
export async function findPayLinkByProviderId(tx: Db, providerLinkId: string): Promise<PayLinkMatch | null> {
  const [row] = await tx
    .select({
      payLinkId: paymentLinks.id,
      providerLinkId: paymentLinks.providerLinkId,
      amountPaise: paymentLinks.amountPaise,
      status: paymentLinks.status,
      createdOn: paymentLinks.createdOn,
      invoiceId: invoices.id,
      paidOn: invoices.paidOn,
      buyerId: buyers.id,
      supplierId: suppliers.id,
    })
    .from(paymentLinks)
    .innerJoin(invoices, eq(invoices.id, paymentLinks.invoiceId))
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(eq(paymentLinks.providerLinkId, providerLinkId))
    .limit(1);
  return row ?? null;
}

/** Sets a Pay_Link's status to `paid`. Returns `false` when the row does not exist. */
export async function markPayLinkPaid(tx: Db, payLinkId: string): Promise<boolean> {
  const rows = await tx
    .update(paymentLinks)
    .set({ status: "paid" })
    .where(eq(paymentLinks.id, payLinkId))
    .returning({ id: paymentLinks.id });
  return rows.length > 0;
}

/**
 * Sets `invoices.paid_on` to `day` only when it is still null. Returns `true` when it changed the
 * row, `false` when the invoice was already paid (the existing date stays) or does not exist.
 */
export async function setPaidOnIfNull(tx: Db, invoiceId: string, day: CalendarDate): Promise<boolean> {
  const rows = await tx
    .update(invoices)
    .set({ paidOn: day })
    .where(and(eq(invoices.id, invoiceId), isNull(invoices.paidOn)))
    .returning({ id: invoices.id });
  return rows.length > 0;
}
