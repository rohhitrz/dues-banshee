/**
 * Import limits. This file imports nothing, so client code can use it.
 * `MAX_UPLOAD_BYTES` is the single source for the browser, the route and `read-upload.ts`.
 */

/** Largest accepted upload. Vercel rejects bodies over 4.5 MB, so this leaves room for multipart overhead. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Largest number of data rows (rows after the header row) in one import. */
export const MAX_DATA_ROWS = 5000;

/** Allowance for multipart framing when checking `Content-Length` before the body is read. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function uploadTooLargeMessage(): string {
  return `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;
}

export function tooManyRowsMessage(): string {
  return `File has more than ${MAX_DATA_ROWS} rows`;
}
