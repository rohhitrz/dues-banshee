import { handleTwilioInbound, readChannelEnv, type WebhookResponse } from "@dues-banshee/agent";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

/** Keeps string fields only: a file upload is never a Twilio message field. */
function stringParams(form: FormData): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") params[name] = value;
  }
  return params;
}

/**
 * Twilio inbound WhatsApp webhook (log only). Not in the proxy matcher: the Twilio signature is
 * its only credential.
 */
export async function POST(req: Request): Promise<Response> {
  let params: Record<string, string> = {};
  try {
    params = stringParams(await req.formData());
  } catch {
    // Not a form body: the handler answers 503 or 401 for it.
  }
  const signature = req.headers.get("x-twilio-signature");
  const env = readChannelEnv(process.env);

  const { db, close } = getDb();
  let result: WebhookResponse;
  try {
    result = await handleTwilioInbound({ db, env }, { params, signature });
  } catch (err) {
    console.error("twilio webhook: unexpected failure", err instanceof Error ? err.name : "unknown");
    result = { status: 500, body: JSON.stringify({ error: "internal" }), contentType: "application/json", revalidateBuyerId: null };
  } finally {
    await close().catch(() => console.error("twilio webhook: close failed"));
  }

  return new Response(result.body, { status: result.status, headers: { "content-type": result.contentType } });
}
