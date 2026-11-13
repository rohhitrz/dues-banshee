"use client";

import { useRef, useState, type ChangeEvent } from "react";
import type { PreviewResponse, PreviewRow } from "@/lib/import/analyse";
import { MAX_UPLOAD_BYTES, uploadTooLargeMessage } from "@/lib/import/limits";
import styles from "./import.module.css";

interface CommitResponse {
  inserted: number;
  skipped: number;
  errors: number;
}

interface FileErrorBody {
  error?: string;
  fileErrors?: { code: string; message: string }[];
}

type Busy = "preview" | "commit" | null;

const STATUS_LABEL: Record<PreviewRow["status"], string> = {
  new: "new",
  already_imported: "already imported",
  error: "error",
};

/** Turns a non-2xx response into the message(s) to show. Never throws. */
async function failureMessages(response: Response): Promise<string[]> {
  let body: FileErrorBody = {};
  try {
    body = (await response.json()) as FileErrorBody;
  } catch {
    // Not JSON (for example a platform error page): fall through to the generic message.
  }
  if (body.fileErrors && body.fileErrors.length > 0) return body.fileErrors.map((e) => e.message);
  if (body.error) return [body.error];
  return [`Request failed (HTTP ${response.status}).`];
}

function postFile(url: string, file: File): Promise<Response> {
  const form = new FormData();
  form.set("file", file);
  return fetch(url, { method: "POST", body: form });
}

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<CommitResponse | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // Bumped whenever the chosen file changes, so a slow response for an old file is dropped.
  const generation = useRef(0);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    generation.current += 1;
    setBusy(null);
    setPreview(null);
    setResult(null);
    const chosen = event.target.files?.[0] ?? null;
    if (chosen !== null && chosen.size > MAX_UPLOAD_BYTES) {
      setFile(null);
      setErrors([uploadTooLargeMessage()]);
      return;
    }
    setFile(chosen);
    setErrors([]);
  }

  async function run<T>(kind: Exclude<Busy, null>, url: string, onSuccess: (body: T) => void) {
    if (file === null) return;
    const mine = generation.current;
    setBusy(kind);
    setErrors([]);
    try {
      const response = await postFile(url, file);
      if (mine !== generation.current) return;
      if (!response.ok) {
        const messages = await failureMessages(response);
        if (mine === generation.current) setErrors(messages);
        return;
      }
      const body = (await response.json()) as T;
      if (mine === generation.current) onSuccess(body);
    } catch {
      if (mine === generation.current) setErrors(["Could not reach the server. Nothing was saved."]);
    } finally {
      if (mine === generation.current) setBusy(null);
    }
  }

  const onPreview = () => {
    setResult(null);
    void run<PreviewResponse>("preview", "/api/import/preview", setPreview);
  };

  const onCommit = () => {
    void run<CommitResponse>("commit", "/api/import/commit", (body) => {
      setResult(body);
      setPreview(null);
    });
  };

  const newCount = preview?.counts.new ?? 0;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Import invoices</h1>

      <div className={styles.controls}>
        <label className={styles.fileLabel}>
          Choose a .csv or .xlsx file
          <input
            className={styles.fileInput}
            type="file"
            accept=".csv,.xlsx"
            onChange={onFileChange}
          />
        </label>
        <button
          type="button"
          className={styles.button}
          onClick={onPreview}
          disabled={file === null || busy !== null}
        >
          {busy === "preview" ? "Reading…" : "Preview"}
        </button>
      </div>
      {file === null ? null : <p className={styles.fileName}>{file.name}</p>}

      {errors.length === 0 ? null : (
        <div role="alert" className={styles.error}>
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}

      {preview === null ? null : (
        <section aria-label="Preview">
          <p className={styles.summary}>
            {preview.counts.new} new, {preview.counts.already_imported} already imported,{" "}
            {preview.counts.error} with errors. Header found on row {preview.headerRowNumber}.
          </p>
          <p className={styles.summary}>
            Unused columns:{" "}
            {preview.unusedColumns.length === 0 ? "none" : preview.unusedColumns.join(", ")}
          </p>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Status</th>
                  <th scope="col">Invoice no.</th>
                  <th scope="col">Buyer</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Invoice date</th>
                  <th scope="col">Accepted date</th>
                  <th scope="col">Warnings and errors</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{STATUS_LABEL[row.status]}</td>
                    <td>{row.invoiceNumber ?? ""}</td>
                    <td>{row.buyerName ?? ""}</td>
                    <td>{row.amountText ?? ""}</td>
                    <td>{row.invoiceDate ?? ""}</td>
                    <td>
                      {row.acceptedOn ?? ""}
                      {row.acceptanceDateDefaulted ? (
                        <span className={styles.note}> (defaulted to invoice date)</span>
                      ) : null}
                    </td>
                    <td>
                      {row.warnings.length === 0 && row.errors.length === 0 ? null : (
                        <ul className={styles.notes}>
                          {row.warnings.map((warning) => (
                            <li key={`w:${warning}`}>{warning}</li>
                          ))}
                          {row.errors.map((error) => (
                            <li key={`e:${error.column}:${error.reason}`}>
                              {error.column}: {error.reason}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            className={styles.button}
            onClick={onCommit}
            disabled={newCount === 0 || busy !== null}
          >
            {busy === "commit"
              ? "Importing…"
              : `Import ${newCount} new ${newCount === 1 ? "invoice" : "invoices"}`}
          </button>
        </section>
      )}

      {result === null ? null : (
        <p role="status" className={styles.summary}>
          Imported {result.inserted}, skipped {result.skipped} already imported, {result.errors} with
          errors (not imported).
        </p>
      )}
    </main>
  );
}
