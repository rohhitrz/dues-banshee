import type { TimelineEntry } from "@/lib/debtor/candle-timeline";
import styles from "./candle-timeline.module.css";

export interface CandleTimelineProps {
  entries: readonly TimelineEntry[];
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
          </span>
        </li>
      ))}
    </ol>
  );
}
