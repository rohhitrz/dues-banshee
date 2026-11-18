import { istCalendarDate } from "@dues-banshee/engine";
import type { CalendarDate, Paise } from "@dues-banshee/engine";
import { z } from "zod";

/** The only event type that changes anything. Every other type is recorded and ignored (Req 6.5). */
export const PAYMENT_LINK_PAID = "payment_link.paid";

/** The outcomes of a verified, non-duplicate delivery. `duplicate` is decided earlier, by the event-id insert. */
export type RazorpayOutcome =
  | "paid"
  | "already_paid"
  | "ignored_event_type"
  | "unknown_link"
  | "amount_mismatch"
  | "invalid_payload";

/** The fields of a `payment_link.paid` event the handler reads (Req 6.3). Everything else is ignored. */
export const paymentLinkPaidSchema = z.object({
  event: z.literal(PAYMENT_LINK_PAID),
  payload: z.object({
    payment_link: z.object({
      entity: z.object({
        id: z.string().min(1),
        amount_paid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      }),
    }),
    payment: z.object({
      entity: z.object({
        /** Unix seconds. */
        created_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER / 1000),
      }),
    }),
  }),
});

export type PaymentLinkPaidEvent = z.infer<typeof paymentLinkPaidSchema>;

/** The fields of a `payment_link.paid` event after schema validation. */
export interface PaidEventFields {
  linkId: string;
  amountPaidPaise: Paise;
  /** `payload.payment.entity.created_at`, Unix seconds. */
  paymentCreatedAtSec: number;
}

/**
 * An event read from the verified JSON body. `type` is the top-level `event` string, or `null` when
 * the body has none. `paid` holds the validated fields when the type is `payment_link.paid` and the
 * schema accepts them, else `null`.
 */
export interface ParsedRazorpayEvent {
  type: string | null;
  paid: PaidEventFields | null;
}

/** Reads the event type and, for `payment_link.paid`, validates the fields with Zod. Never throws. */
export function parseRazorpayEvent(json: unknown): ParsedRazorpayEvent {
  const type =
    typeof json === "object" && json !== null && typeof (json as { event?: unknown }).event === "string"
      ? (json as { event: string }).event
      : null;
  if (type !== PAYMENT_LINK_PAID) return { type, paid: null };
  const parsed = paymentLinkPaidSchema.safeParse(json);
  if (!parsed.success) return { type, paid: null };
  const { payment_link, payment } = parsed.data.payload;
  return {
    type,
    paid: {
      linkId: payment_link.entity.id,
      amountPaidPaise: payment_link.entity.amount_paid,
      paymentCreatedAtSec: payment.entity.created_at,
    },
  };
}

/** The stored Pay_Link fields the classifier needs, or `null` when no stored link has the event's id. */
export interface StoredPayLink {
  /** Pay_Amount in paise. */
  amountPaise: Paise;
  /** `invoices.paid_on` of the link's invoice. */
  paidOn: CalendarDate | null;
}

/**
 * Pure: returns exactly one outcome, in this order (design Property 7):
 * 1. a type other than `payment_link.paid` → `ignored_event_type`;
 * 2. a `payment_link.paid` event whose fields fail the schema (or a body with no event type) → `invalid_payload`;
 * 3. no stored Pay_Link → `unknown_link`;
 * 4. `amount_paid` different from the Pay_Amount → `amount_mismatch`;
 * 5. the invoice already has a `paid_on` → `already_paid`;
 * 6. otherwise `paid`.
 */
export function classifyRazorpayEvent(event: ParsedRazorpayEvent, link: StoredPayLink | null): RazorpayOutcome {
  if (event.type !== null && event.type !== PAYMENT_LINK_PAID) return "ignored_event_type";
  if (event.paid === null) return "invalid_payload";
  if (link === null) return "unknown_link";
  if (event.paid.amountPaidPaise !== link.amountPaise) return "amount_mismatch";
  if (link.paidOn !== null) return "already_paid";
  return "paid";
}

/**
 * The Payment_Day written to `invoices.paid_on` (Req 6.3). The demo supplier uses the day its link
 * was created, so a demo payment made after the clock moved still lands on the demo's Today. Every
 * other supplier uses the IST calendar day of the payment's `created_at`.
 */
export function paymentDay(isDemo: boolean, linkCreatedOn: CalendarDate, paymentCreatedAtSec: number): CalendarDate {
  return isDemo ? linkCreatedOn : istCalendarDate(paymentCreatedAtSec * 1000);
}
