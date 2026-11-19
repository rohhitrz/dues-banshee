import type { CallDetails, TimelineEntry } from "@/lib/debtor/candle-timeline";
import styles from "./candle-timeline.module.css";

export interface CandleTimelineProps {
  entries: readonly TimelineEntry[];
}

const SPEAKER_LABEL = { buyer: "Buyer", agent: "Agent" } as const;

/**
 * The transcript and tool calls of one call, closed by default. Every value is untrusted text (the buyer
 * speaks it, the model writes it): it is rendered only as React text children, so it is escaped.
 */
function CallDetailsView({ call }: { call: CallDetails }) {
  return (
    <details className={styles.details}>
      <summary className={styles.summary}>Call details</summary>
      <h3 className={styles.detailsHeading}>Transcript</h3>
      {call.transcript.length === 0 ? (
        <p className={styles.detailsEmpty}>No transcript lines</p>
      ) : (
        <ul className={styles.lines}>
          {call.transcript.map((line) => (
            <li key={line.id} className={styles.line}>
              <span className={styles.speaker}>{SPEAKER_LABEL[line.speaker]}</span>
              <span>{line.text}</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className={styles.detailsHeading}>Tool calls</h3>
      {call.toolCalls.length === 0 ? (
        <p className={styles.detailsEmpty}>No tool calls</p>
      ) : (
        <ul className={styles.lines}>
          {call.toolCalls.map((t) => (
            <li key={t.id} className={styles.line}>
              <span className={styles.speaker}>{t.tool}</span>
              <code className={styles.code}>{`arguments: ${t.arguments}`}</code>
              <code className={styles.code}>{`result: ${t.result}`}</code>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * The buyer's history as an ordered list. Each entry's date, text and invoice number are plain text; the
 * candle graphic is decorative and aria-hidden, and encodes lit (date reached) and tone (kind and state).
 */
export function CandleTimeline({ entries }: CandleTimelineProps) {
  return (
    <ol className={styles.timeline}>
      {entries.map((entry) => (
        <li
          key={`${entry.kind}-${entry.rowId}`}
          className={styles.entry}
          data-kind={entry.kind}
          data-lit={entry.lit ? "true" : "false"}
          data-tone={entry.tone}
        >
          <span className={styles.candle} aria-hidden="true" />
          <span className={styles.body}>
            <span className={styles.date}>{entry.dateText}</span>
            <span className={styles.text}>{entry.text}</span>
            <span className={styles.invoice}>{entry.invoiceNumber}</span>
            {entry.call === undefined ? null : <CallDetailsView call={entry.call} />}
          </span>
        </li>
      ))}
    </ol>
  );
}
