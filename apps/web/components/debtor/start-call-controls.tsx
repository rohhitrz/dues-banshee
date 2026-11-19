"use client";

import { useActionState } from "react";
import { startCall, type StartCallView } from "@/app/(debtor)/debtors/[id]/call-actions";
import {
  CALL_COPY,
  CALL_DISCLAIMER,
  DEMO_HOURS_TEXT,
  NOT_CALLABLE_TEXT,
  NOT_CONFIGURED_TEXT,
} from "@/lib/call/call-copy";
import type { StartCallControlsData } from "@/lib/debtor/build-start-call-controls";
import styles from "./start-call-controls.module.css";

// This module runs in the browser. It must not import @dues-banshee/agent, @dues-banshee/db or
// @dues-banshee/voice: every flag arrives from the server as a plain prop, and the API key never does.

export interface StartCallControlsProps {
  data: StartCallControlsData;
}

/** Shown when the action rejects (network drop, server crash): nothing is known about the call. */
const GENERIC_FAILURE_TEXT = "Something went wrong. Try again.";

/**
 * "Start call" for one Invoice_Panel (Req 1). Enabled only for a callable invoice with the voice key set.
 * After a start it shows the one-time call link; nothing is persisted, so a reload hides it again.
 */
export function StartCallControls({ data }: StartCallControlsProps) {
  const { invoiceId, callable, configured, isDemo, override } = data;

  const [result, action, pending] = useActionState<StartCallView | null, FormData>(async (prev, form) => {
    try {
      return await startCall(prev, form);
    } catch {
      return { invoiceId, text: GENERIC_FAILURE_TEXT, role: "alert" };
    }
  }, null);

  // Refusal order of Req 1 C13: not configured comes before not callable.
  const reason = !configured ? NOT_CONFIGURED_TEXT : !callable ? NOT_CALLABLE_TEXT : null;
  const noteId = `start-call-note-${invoiceId}`;

  return (
    <div className={styles.controls}>
      <form action={action} className={styles.action}>
        <input type="hidden" name="invoiceId" value={invoiceId} />
        {override === null ? null : <input type="hidden" name="today" value={override} />}
        <button
          type="submit"
          className={styles.button}
          disabled={reason !== null || pending}
          aria-describedby={reason === null ? undefined : noteId}
        >
          Start call
        </button>
        {reason === null ? null : (
          <span id={noteId} className={styles.note}>
            {reason}
          </span>
        )}
      </form>
      {isDemo ? <p className={styles.note}>{DEMO_HOURS_TEXT}</p> : null}
      {reason === null ? (
        <>
          <p className={styles.note}>{CALL_COPY}</p>
          <p className={styles.note}>{CALL_DISCLAIMER}</p>
        </>
      ) : null}
      {result === null ? null : (
        <div className={styles.result}>
          <p role={result.role} className={result.role === "alert" ? styles.alert : styles.status}>
            {result.text}
          </p>
          {result.role === "status" && result.callUrl !== undefined ? (
            <>
              <p className={styles.url}>{result.callUrl}</p>
              <div className={styles.links}>
                <a href={result.callUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                  Open call here
                </a>
                {result.waMeUrl === undefined ? null : (
                  <a href={result.waMeUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                    Send call link in WhatsApp
                  </a>
                )}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
