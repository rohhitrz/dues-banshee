import { importInvoices } from "@dues-banshee/db";
import { analyseUpload } from "@/lib/import/analyse";
import { handleImportRequest } from "@/lib/import/route-guard";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleImportRequest(request, "commit", async ({ db, supplierId, file, rowNumbers }) => {
    const result = await analyseUpload(db, supplierId, file);
    if (!result.ok) {
      return Response.json(
        { error: result.message, ...(result.fileErrors && { fileErrors: result.fileErrors }) },
        { status: result.status },
      );
    }
    for (const row of result.okRows) rowNumbers.push(row.rowNumber);

    const { inserted, skipped } = await importInvoices(db, supplierId, result.okRows);
    return Response.json({ inserted, skipped, errors: result.preview.counts.error });
  });
}
