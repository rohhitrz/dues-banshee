import type { CalendarDate } from "@dues-banshee/engine";
import type { TombstoneView } from "@/lib/graveyard/build-graveyard";
import { bankRateMissingText } from "./bank-rate-message";
import styles from "./tombstone.module.css";

export interface TombstoneProps {
  view: TombstoneView;
  /** Today, used only for the "Bank rate not configured for <Today>" text. */
  today: CalendarDate;
}

const CAVEAT_TEXT = "Registered on Udyam after supply: claim may be contested";

/**
 * One invoice as a tombstone. The stone is decorative and aria-hidden; every figure sits on the plaque
 * below it, never on the stone. Read-only: no buttons or controls (Req 5.6).
 */
export function Tombstone({ view, today }: TombstoneProps) {
  const { look } = view;
  const showOverdue = view.state === "overdue" || view.state === "armed" || view.state === "exploded";
  const overdueText =
    view.state === "overdue"
      ? `Overdue ${view.daysOverdue} days`
      : `Overdue ${view.daysOverdue} days, interest accruing`;

  return (
    <li className={styles.item}>
      <article className={styles.article} tabIndex={0} aria-label={view.ariaLabel} data-state={view.state}>
        <div className={styles.ground} aria-hidden="true">
          {look.wisp ? <span className={styles.wisp} data-look="wisp" /> : null}
          <div className={styles.stone} style={{ height: `${look.heightPx}px` }}>
            <span className={styles.moss} data-moss={look.moss} />
            {look.cracked ? (
              <svg className={styles.cracks} data-look="cracks" viewBox="0 0 86 100" preserveAspectRatio="none">
                <path d="M30 0 L38 22 L28 38 L40 58 L33 80 L38 100" />
                <path d="M38 22 L52 30 L50 46" />
                <path d="M40 58 L56 66" />
              </svg>
            ) : null}
            {look.ember ? <span className={styles.ember} data-look="ember" /> : null}
            <span className={styles.rip}>R.I.P.</span>
          </div>
        </div>

        <div className={styles.plaque}>
          <p className={styles.buyer}>{view.buyerName}</p>
          <p className={styles.invoiceNumber}>{view.invoiceNumber}</p>
          <p className={styles.principal}>{view.principalText}</p>
          {view.dueDateText === null ? null : (
            <p className={styles.line}>{`Due ${view.dueDateText} · MSMED-15`}</p>
          )}
          {showOverdue ? <p className={styles.line}>{overdueText}</p> : null}
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
          <p className={styles.next}>{view.nextLabel}</p>
        </div>
      </article>
    </li>
  );
}
