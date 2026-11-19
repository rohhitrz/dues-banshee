import type { Db } from "@dues-banshee/db";
import type { VoiceHandlerResponse } from "@dues-banshee/voice";
import { revalidatePath } from "next/cache";
import type { ZodType } from "zod";
import { getDb } from "@/lib/db";

/**
 * Shared adapter for the `/api/voice/{tool,transcript,end}` route files. Server only: it reads the
 * database url and calls `revalidatePath`. The handlers in `@dues-banshee/voice` hold the logic;
 * this only turns a `Request` into their input and their result into a `Response`.
 */

const HEADERS = { "content-type": "application/json", "cache-control": "no-store" } as const;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/**
 * Parses the JSON body with `schema` (non-strict, so extra fields such as an invoice id or an outcome
 * are dropped), runs `run` with a connection and `new Date()`, and answers. An unreadable or oversize
 * body is an envelope failure: 404 `not_found`, the same as a call that does not match. An unexpected
 * error logs only the error name and answers 500 `{"error":"internal"}`: no stack, SQL or driver text.
 */
export async function handleVoiceRoute<T, B>(
  req: Request,
  schema: ZodType<T>,
  label: string,
  run: (db: Db, body: T, now: Date) => Promise<VoiceHandlerResponse<B>>,
): Promise<Response> {
  let body: T;
  try {
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) return respond(404, { error: "not_found" });
    body = parsed.data;
  } catch {
    return respond(404, { error: "not_found" });
  }

  let result: VoiceHandlerResponse<B>;
  let close: (() => Promise<void>) | undefined;
  try {
    const conn = getDb();
    close = conn.close;
    result = await run(conn.db, body, new Date());
  } catch (err) {
    console.error(`${label}: unexpected failure`, err instanceof Error ? err.name : "unknown");
    return respond(500, { error: "internal" });
  } finally {
    await close?.().catch(() => console.error(`${label}: close failed`));
  }

  if (result.revalidateBuyerId !== undefined) {
    try {
      revalidatePath("/");
      revalidatePath(`/debtors/${result.revalidateBuyerId}`);
    } catch {
      // The change is committed; a failed cache purge must not turn into an error for the client.
      console.error(`${label}: revalidate failed`);
    }
  }
  return respond(result.status, result.body);
}
