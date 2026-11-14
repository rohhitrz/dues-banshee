import type { CalendarDate } from "@dues-banshee/engine";
import type { InvoicePanelView } from "@/lib/debtor/build-debtor-view";
import { bankRateMissingText } from "@/components/graveyard/bank-rate-message";
import { CAVEAT_TEXT } from "@/components/graveyard/tombstone";
import { PlaceholderActions } from "./placeholder-actions";
import styles from "./invoice-panel.module.css";

export interface InvoicePanelProps {
  panel: InvoicePanelView;
  /** Today, used only for the "Bank rate not configured for <Today>" text. */
  today: CalendarDate;
}

/**
 * One invoice of the buyer. Every figure comes from the Tombstone_View the Graveyard_Builder produced; this
 * component only lays it out. No money maths: amounts arrive as already-formatted strings.
 */
export function InvoicePanel({ panel, today }: InvoicePanelProps) {
  const view = panel.tombstone;

  return (
    <section id={panel.panelId} className={styles.panel} data-state={view.state}>
      <h2 className={styles.invoiceNumber}>{view.invoiceNumber}</h2>
      <p className={styles.principal}>{view.principalText}</p>
      {view.dueDateText === null ? null : <p className={styles.line}>{`Due ${view.dueDateText} · MSMED-15`}</p>}
      {panel.overdueText === null ? null : <p className={styles.line}>{panel.overdueText}</p>}
      {view.interest !== null ? (
        <p className={styles.line}>{`Interest ${view.interest.text} · MSMED-16`}</p>
      ) : view.state === "not_covered" ? null : (
        <p className={styles.missing}>{bankRateMissingText(today)}</p>
      )}
      <p className={styles.line}>
        <span className={styles.state} data-state={view.state}>
          {view.stateText}
        </span>
        {view.stateRuleId === null ? null : <span className={styles.rule}>{view.stateRuleId}</span>}
      </p>
      {view.caveat === "registered_after_supply" ? <p className={styles.caveat}>{CAVEAT_TEXT}</p> : null}
      {panel.promiseUntilText === null ? null : <p className={styles.promise}>{panel.promiseUntilText}</p>}
      <p className={styles.next}>{view.nextLabel}</p>
      {panel.showPlaceholders ? <PlaceholderActions invoiceId={view.id} /> : null}
    </section>
  );
}
