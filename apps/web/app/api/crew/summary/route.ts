import { DEMO_SUPPLIER, findSupplierIdByUdyam } from "@dues-banshee/db";
import { bearerMatches } from "@/lib/bearer";
import { toCrewSummary } from "@/lib/crew/summary";
import { getDb } from "@/lib/db";
import { loadGraveyardData } from "@/lib/graveyard/load";
import { resolveToday } from "@/lib/graveyard/today";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * Read-only feed of the demo supplier's graveyard for the Crew app. Called with
 * `Authorization: Bearer <CREW_READ_SECRET>`. The route is not in the proxy matcher: the bearer
 * secret is its only credential. Logs carry a stage label only, never the error, token or secret.
 */
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CREW_READ_SECRET;
  if (!secret) return json({ error: "not_configured" }, 503);
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return json({ error: "Unauthorized" }, 401);
  }

  const resolved = resolveToday(Date.now(), new URL(request.url).searchParams.get("today") ?? undefined);

  let handle: ReturnType<typeof getDb>;
  try {
    handle = getDb();
  } catch {
    console.error("crew summary failed", { stage: "getDb" });
    return json({ error: "load_failed" }, 500);
  }

  try {
    const supplierId = await findSupplierIdByUdyam(handle.db, DEMO_SUPPLIER.udyamNumber);
    if (supplierId === null) return json({ error: "not_found" }, 404);
    const result = await loadGraveyardData(handle.db, supplierId, resolved.today);
    if (result.kind === "stale") return json({ error: "not_found" }, 404);
    if (result.kind === "error") return json({ error: "load_failed" }, 500);
    return json(toCrewSummary(result.view, resolved.override !== null), 200);
  } catch {
    console.error("crew summary failed", { stage: "load" });
    return json({ error: "load_failed" }, 500);
  } finally {
    await handle.close();
  }
}
