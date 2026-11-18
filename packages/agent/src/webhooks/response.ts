/**
 * What a webhook handler hands back to its route file. The route turns it into a `Response`.
 * `revalidateBuyerId` is set only when the handler committed a change the pages must show
 * (the Razorpay webhook, when `paid_on` changed).
 */
export interface WebhookResponse {
  status: 200 | 400 | 401 | 500 | 503;
  body: string;
  contentType: "application/json" | "text/xml";
  revalidateBuyerId: string | null;
}

/** A JSON response with no internals: a fixed error code string and nothing else. */
export function jsonResponse(
  status: WebhookResponse["status"],
  body: Record<string, string>,
  revalidateBuyerId: string | null = null,
): WebhookResponse {
  return { status, body: JSON.stringify(body), contentType: "application/json", revalidateBuyerId };
}
