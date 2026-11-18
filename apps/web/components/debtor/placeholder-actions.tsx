import styles from "./placeholder-actions.module.css";

export interface PlaceholderActionsProps {
  /** The invoice id; keeps the description id unique per invoice. */
  invoiceId: string;
}

/**
 * "Start call" is visible but disabled until buyer-voice-call switches it on. No handler, no form action,
 * no server call. "Send pay link" moved to SendControls with whatsapp-channel.
 */
export function PlaceholderActions({ invoiceId }: PlaceholderActionsProps) {
  const callId = `start-call-note-${invoiceId}`;
  return (
    <div className={styles.actions}>
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
