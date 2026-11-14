import { SupplierNotFoundError, getDraftForSupplier, getSupplier, type DraftWithContext } from "@dues-banshee/db";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Loaded = { kind: "ok"; item: DraftWithContext | null } | { kind: "stale" };

/** The supplier is checked first, so a stale session is told apart from an unknown Draft. */
async function load(supplierId: string, draftId: string): Promise<Loaded> {
  const { db, close } = getDb();
  try {
    await getSupplier(db, supplierId);
    return { kind: "ok", item: await getDraftForSupplier(db, supplierId, draftId) };
  } catch (err) {
    if (err instanceof SupplierNotFoundError) return { kind: "stale" };
    throw err;
  } finally {
    await close().catch((err: unknown) => console.error("draft document: close failed", err));
  }
}

function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

/**
 * Downloads the PDF attached to a Legal_Notice or ODR_Pack Draft of the signed-in supplier.
 * The supplier comes from the session only; the URL carries just the Draft id, and a Draft of
 * another supplier is indistinguishable from an unknown one (404).
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await auth();
  const supplierId = session?.supplierId;
  if (!supplierId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();

  const result = await load(supplierId, id);
  if (result.kind === "stale") {
    return Response.redirect(new URL("/signin?error=SessionExpired", request.url), 303);
  }

  const document = result.item?.draft.document;
  if (!result.item || !document) return notFound();

  return new Response(new Uint8Array(document), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${result.item.draft.step}-${result.item.draft.id}.pdf"`,
      "Content-Length": String(document.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
