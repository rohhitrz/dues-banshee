import type { Db } from "@dues-banshee/db";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import {
  MAX_UPLOAD_BYTES,
  MULTIPART_OVERHEAD_BYTES,
  uploadTooLargeMessage,
} from "./limits";

export const IMPORT_FAILED_MESSAGE = "Import failed. Nothing was saved.";

export interface ImportContext {
  db: Db;
  /** From the session only. Nothing in the request body can change it (Requirement 13.7). */
  supplierId: string;
  file: File | null;
  /** Handlers record the row numbers they are working on, so a failure can be logged without cell contents. */
  rowNumbers: number[];
}

const json = (body: unknown, status: number): Response => Response.json(body, { status });

/** `Content-Length` is advisory. A missing or non-numeric value is left to the size check after reading. */
function declaredLength(request: Request): number | null {
  const header = request.headers.get("content-length");
  if (header === null || !/^\d+$/.test(header)) return null;
  return Number(header);
}

/**
 * Logs the failure without cell contents: the error's name and Postgres code/constraint (when present),
 * never its message or detail, which can quote the failing row. Row numbers are safe.
 */
function logImportFailure(route: string, error: unknown, rowNumbers: readonly number[]): void {
  const info: Record<string, unknown> = { route, rowNumbers };
  if (error instanceof Error) {
    info.errorName = error.name;
    const { code, constraint } = error as { code?: unknown; constraint?: unknown };
    if (typeof code === "string") info.code = code;
    if (typeof constraint === "string") info.constraint = constraint;
  } else {
    info.errorName = typeof error;
  }
  console.error("Import failed", info);
}

/**
 * The guard shared by the preview and commit routes:
 * session check (401), `Content-Length` check before the body is read (413), file extraction,
 * a database client that is always closed, and the 500 response for unexpected errors.
 * Requirements 12.5, 13.3, 13.5, 13.6, 13.7.
 */
export async function handleImportRequest(
  request: Request,
  route: string,
  run: (context: ImportContext) => Promise<Response>,
): Promise<Response> {
  const session = await auth();
  const supplierId = session?.supplierId;
  if (!supplierId) return json({ error: "Unauthorized" }, 401);

  const length = declaredLength(request);
  if (length !== null && length > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return json({ error: uploadTooLargeMessage() }, 413);
  }

  const rowNumbers: number[] = [];
  let close: (() => Promise<void>) | undefined;
  try {
    let file: File | null = null;
    try {
      const value = (await request.formData()).get("file");
      if (value instanceof File) file = value;
    } catch {
      // Not a readable multipart body: treated as "no file", which analyseUpload reports.
    }

    const database = getDb();
    close = database.close;
    return await run({ db: database.db, supplierId, file, rowNumbers });
  } catch (error) {
    logImportFailure(route, error, rowNumbers);
    return json({ error: IMPORT_FAILED_MESSAGE }, 500);
  } finally {
    if (close) await close().catch(() => undefined);
  }
}
