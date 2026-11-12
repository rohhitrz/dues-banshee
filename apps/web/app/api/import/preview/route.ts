import { analyseUpload } from "@/lib/import/analyse";
import { handleImportRequest } from "@/lib/import/route-guard";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleImportRequest(request, "preview", async ({ db, supplierId, file, rowNumbers }) => {
    const result = await analyseUpload(db, supplierId, file);
    if (!result.ok) {
      return Response.json(
        { error: result.message, ...(result.fileErrors && { fileErrors: result.fileErrors }) },
        { status: result.status },
      );
    }
    for (const row of result.preview.rows) rowNumbers.push(row.rowNumber);
    return Response.json(result.preview);
  });
}
