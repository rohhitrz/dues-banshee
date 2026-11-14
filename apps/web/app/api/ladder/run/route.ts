import { createHash, timingSafeEqual } from "node:crypto";
import { productionModels, runLadder, type LadderRunResult } from "@dues-banshee/agent";
import { DEMO_SUPPLIER, listRunSuppliers } from "@dues-banshee/db";
import type { CalendarDate } from "@dues-banshee/engine";
import { getDb } from "@/lib/db";
import { istDate, resolveToday } from "@/lib/graveyard/today";

export const runtime = "nodejs";
/** One supplier can make up to 20 Draft_Attempts x up to 3 model calls, run one after another. */
export const maxDuration = 300;

type RunEntry = LadderRunResult | { supplierId: string; today: CalendarDate; error: "run_failed" };

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compares SHA-256 digests, so both buffers have equal length and the comparison is constant-time. */
function bearerMatches(header: string | null, secret: string): boolean {
  const match = header === null ? null : /^Bearer (.+)$/.exec(header);
  const presented = match?.[1] ?? "";
  return timingSafeEqual(sha256(presented), sha256(secret)) && presented.length > 0;
}

/**
 * Runs one Ladder_Run per supplier. Called by the daily cron with `Authorization: Bearer <secret>`.
 * The route is not in the proxy matcher: the bearer secret is its only credential.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.LADDER_RUN_SECRET;
  if (!secret) return Response.json({ error: "not_configured" }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const nowMs = Date.now();
  const demoToday = resolveToday(nowMs, new URL(request.url).searchParams.get("today") ?? undefined).today;
  const realToday = istDate(nowMs);

  const { db, close } = getDb();
  try {
    const models = productionModels();
    const runs: RunEntry[] = [];
    for (const supplier of await listRunSuppliers(db)) {
      const today = supplier.udyamNumber === DEMO_SUPPLIER.udyamNumber ? demoToday : realToday;
      try {
        runs.push(await runLadder({ db, models }, supplier.id, today));
      } catch (err) {
        console.error("ladder run failed", { supplierId: supplier.id, today }, err);
        runs.push({ supplierId: supplier.id, today, error: "run_failed" });
      }
    }
    return Response.json({ runs });
  } finally {
    await close();
  }
}
