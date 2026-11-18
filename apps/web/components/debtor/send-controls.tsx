"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { openInWhatsApp, sendPayLink, type SendView } from "@/app/(debtor)/debtors/[id]/send-actions";
import type { SendControlsData } from "@/lib/debtor/build-send-controls";
import styles from "./send-controls.module.css";

// This module runs in the browser. It must not import @dues-banshee/agent, @dues-banshee/db or twilio:
// the preview text and every flag arrive from the server as plain props.

export interface SendControlsProps {
  data: SendControlsData;
}

/** A result with the order in which it came back, so the newer of the two forms' results is the one shown. */
type Stamped = SendView & { seq: number };

/** Shown when the "Open in WhatsApp" action rejects (network drop, server crash): nothing is known about the send. */
const GENERIC_FAILURE_TEXT = "Something went wrong. Try again.";
const REASON_TEXT = {
  no_draft: "Approve a WhatsApp draft first",
  no_number: "No WhatsApp number for this buyer",
  sender_not_configured: "WhatsApp sender not configured",
} as const;

/**
 * "Send pay link" (Twilio sandbox) and "Open in WhatsApp" (wa.me hand-off) for one Invoice_Panel (Req 4).
 * Nothing is computed here: the state, the preview and the sent line were decided on the server.
 */
export function SendControls({ data }: SendControlsProps) {
  const { invoiceId, state, sentText, override } = data;
  const seq = useRef(0);
  const tab = useRef<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  const [sendResult, sendAction, sendPending] = useActionState<Stamped | null, FormData>(async (prev, form) => {
    const view = await sendPayLink(prev, form);
    seq.current += 1;
    return { ...view, seq: seq.current };
  }, null);
  const [openResult, openAction, openPending] = useActionState<Stamped | null, FormData>(async (prev, form) => {
    let view: SendView;
    try {
      view = await openInWhatsApp(prev, form);
    } catch {
      // Without a result the blank tab would stay open and the rejection would reach the error boundary.
      // An alert without a `url` makes the effect below close the tab.
      view = { invoiceId, text: GENERIC_FAILURE_TEXT, role: "alert" };
    }
    seq.current += 1;
    return { ...view, seq: seq.current };
  }, null);

  // The tab was opened synchronously on submit. Now that the action has returned, point it at the wa.me
  // URL, or close it when nothing was sent.
  useEffect(() => {
    const opened = tab.current;
    if (openResult === null || opened === null) return;
    tab.current = null;
    if (openResult.url !== undefined) opened.location.href = openResult.url;
    else opened.close();
  }, [openResult]);

  function onOpenSubmit() {
    // A popup opened after an `await` is blocked, so open the blank tab now, inside the click. With
    // "noopener" in the features `window.open` returns null, so the opener is cleared by hand instead.
    const opened = window.open("about:blank", "_blank");
    if (opened !== null) opened.opener = null;
    tab.current = opened;
    setPopupBlocked(opened === null);
  }

  const busy = sendPending || openPending;
  const latest =
    sendResult !== null && (openResult === null || sendResult.seq > openResult.seq) ? sendResult : openResult;
  const reasonId = `send-note-${invoiceId}`;
  const ready = state.kind === "ready";
  const reason = state.kind === "ready" ? null : REASON_TEXT[state.kind];
  const preview = state.kind === "no_draft" || state.preview === "" ? null : state.preview;
  const hidden =
    state.kind === "no_draft" ? null : (
      <>
        <input type="hidden" name="draftId" value={state.draftId} />
        {override === null ? null : <input type="hidden" name="today" value={override} />}
      </>
    );

  return (
    <div className={styles.controls}>
      {sentText === null ? null : <p className={styles.sent}>{sentText}</p>}
      {preview === null ? null : (
        <div className={styles.previewBox}>
          <p className={styles.label}>Message to send</p>
          <pre className={styles.preview}>{preview}</pre>
        </div>
      )}
      <div className={styles.actions}>
        <form action={sendAction} className={styles.action}>
          {hidden}
          <button
            type="submit"
            className={styles.button}
            disabled={!ready || busy}
            aria-describedby={reason === null ? undefined : reasonId}
          >
            Send pay link
          </button>
          {reason === null ? null : (
            <span id={reasonId} className={styles.note}>
              {reason}
            </span>
          )}
        </form>
        {state.kind === "no_draft" ? null : (
          <form action={openAction} onSubmit={onOpenSubmit} className={styles.action}>
            {hidden}
            <button type="submit" className={styles.button} disabled={busy}>
              Open in WhatsApp
            </button>
          </form>
        )}
      </div>
      {latest === null ? null : (
        <p role={latest.role} className={latest.role === "alert" ? styles.alert : styles.status}>
          {latest.text}
        </p>
      )}
      {popupBlocked && openResult?.url !== undefined && latest === openResult ? (
        <a href={openResult.url} target="_blank" rel="noopener noreferrer" className={styles.link}>
          Open the WhatsApp link
        </a>
      ) : null}
    </div>
  );
}
