import { realtimeModel } from "@dues-banshee/agent/models";
import { createOpenAiRealtime, handleSession, type SessionResponse } from "@dues-banshee/voice";
import { z } from "zod";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

// Non-strict: extra fields are dropped. The token travels only in this body, never in a URL.
const Body = z.object({ token: z.string().min(1).max(512) });

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/**
 * Join: the buyer's tap on the Call_Page. Not in the proxy matcher: the single-use Join_Token is the
 * credential. Error bodies are fixed strings; the token, the standard key and driver errors never
 * reach a response or a log line.
 */
export async function POST(req: Request): Promise<Response> {
  let token: string;
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return respond(404, { error: "expired" });
    token = parsed.data.token;
  } catch {
    return respond(404, { error: "expired" });
  }

  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const provider = createOpenAiRealtime({
    fetch: (input, init) => fetch(input, init),
    apiKey,
    model: realtimeModel(process.env.VOICE_REALTIME_MODEL),
  });

  let result: SessionResponse;
  let close: (() => Promise<void>) | undefined;
  try {
    const conn = getDb();
    close = conn.close;
    result = await handleSession(
      { db: conn.db, provider, now: new Date(), apiKeyConfigured: apiKey !== "" },
      { token },
    );
  } catch (err) {
    // Name only: a driver error message can carry SQL text or a connection string.
    console.error("voice session route: unexpected failure", err instanceof Error ? err.name : "unknown");
    result = { status: 500, body: { error: "internal" } };
  } finally {
    await close?.().catch(() => console.error("voice session route: close failed"));
  }
  return respond(result.status, result.body);
}
