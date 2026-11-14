import styles from "./placeholder-actions.module.css";

export interface PlaceholderActionsProps {
  /** The invoice id; keeps the description ids unique per invoice. */
  invoiceId: string;
}

/**
 * "Send pay link" and "Start call" are visible but disabled until whatsapp-channel and buyer-voice-call
 * switch them on. No handler, no form action, no server call.
 */
export function PlaceholderActions({ invoiceId }: PlaceholderActionsProps) {
  const payId = `pay-link-note-${invoiceId}`;
  const callId = `start-call-note-${invoiceId}`;
  return (
    <div className={styles.actions}>
      <div className={styles.action}>
        <button type="button" className={styles.button} disabled aria-describedby={payId}>
          Send pay link
        </button>
        <span id={payId} className={styles.note}>
          Arrives with WhatsApp
        </span>
      </div>
      <div className={styles.action}>
        <button type="button" className={styles.button} disabled aria-describedby={callId}>
          Start call
        </button>
        <span id={callId} className={styles.note}>
          Arrives with voice call
        </span>
      </div>
    </div>
  );
}
