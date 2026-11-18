import { handleRazorpayWebhook, readChannelEnv, type WebhookResponse } from "@dues-banshee/agent";
import { DEMO_SUPPLIER, findSupplierIdByUdyam } from "@dues-banshee/db";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Razorpay `payment_link.paid` webhook. Not in the proxy matcher: the HMAC signature is its only
 * credential. The body is read as text first, because the signature covers the exact bytes sent.
 */
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");
  const eventId = req.headers.get("x-razorpay-event-id");
  const env = readChannelEnv(process.env);

  const { db, close } = getDb();
  let result: WebhookResponse;
  try {
    // Only needed once the handler gets past the 503/401 checks, so skip the lookup without a secret.
    const demoSupplierId =
      env.razorpayWebhookSecret === undefined ? null : await findSupplierIdByUdyam(db, DEMO_SUPPLIER.udyamNumber);
    result = await handleRazorpayWebhook(
      { db, env, isDemoSupplier: (supplierId) => demoSupplierId !== null && supplierId === demoSupplierId },
      { rawBody, signature, eventId },
    );
  } catch (err) {
    // Name only: a driver error message can carry SQL text or a connection string.
    console.error("razorpay webhook: unexpected failure", err instanceof Error ? err.name : "unknown");
    result = { status: 500, body: JSON.stringify({ error: "internal" }), contentType: "application/json", revalidateBuyerId: null };
  } finally {
    await close().catch(() => console.error("razorpay webhook: close failed"));
  }

  if (result.revalidateBuyerId !== null) {
    try {
      revalidatePath("/");
      revalidatePath(`/debtors/${result.revalidateBuyerId}`);
    } catch (err) {
      // The payment is committed; a failed cache purge must not turn into a retry.
      console.error("razorpay webhook: revalidate failed", err instanceof Error ? err.name : "unknown");
    }
  }

  return new Response(result.body, { status: result.status, headers: { "content-type": result.contentType } });
}
