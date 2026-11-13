import { formatINR, type CalendarDate, type Paise } from "@dues-banshee/engine";
import type { GraveyardTotals } from "@/lib/graveyard/build-graveyard";
import { formatDisplayDate } from "@/lib/graveyard/today";
import { bankRateMissingText } from "./bank-rate-message";
import styles from "./totals-bar.module.css";

export interface TotalsBarProps {
  totals: GraveyardTotals;
  /** The Bank_Rate `asOf` date, or null when no Bank_Rate applies. */
  rulesAsOf: CalendarDate | null;
  today: CalendarDate;
}

/** A card heading: the themed title from /design/Main.dc.html, then the plain label naming the figure. */
function CardHeading({ title, label, ember = false }: { title: string; label: string; ember?: boolean }) {
  return (
    <dt className={styles.heading}>
      <span className={ember ? `${styles.title} ${styles.titleEmber}` : styles.title}>
        {ember ? <span className={styles.emberDot} aria-hidden="true" /> : null}
        {title}
      </span>
      <span className={styles.label}>{label}</span>
    </dt>
  );
}
function Money({ paise, withShort = false }: { paise: Paise; withShort?: boolean }) {
  const full = formatINR(paise, "full");
  const short = formatINR(paise, "short");
  if (!withShort || short === full) return <span className={styles.value}>{full}</span>;
  return (
    <>
      <span className={styles.value}>{short}</span>
      <span className={styles.sub}>{full}</span>
    </>
  );
}

export function TotalsBar({ totals, rulesAsOf, today }: TotalsBarProps) {
  const missing = bankRateMissingText(today);
  return (
    <section className={styles.bar} aria-label="Totals">
      <dl className={styles.grid}>
        <div className={styles.card}>
          <CardHeading title="Buried in dues" label="Outstanding" />
          <dd className={styles.figure}>
            <Money paise={totals.outstandingPaise} withShort />
          </dd>
        </div>
        <div className={styles.card}>
          <CardHeading title="Interest curse" label="Interest accrued" />
          <dd className={styles.figure}>
            {totals.interestAccruedPaise === null ? (
              <span className={styles.missing}>{missing}</span>
            ) : (
              <>
                <Money paise={totals.interestAccruedPaise} withShort />
                <span className={styles.rule}>MSMED-16</span>
              </>
            )}
          </dd>
        </div>
        <div className={styles.card}>
          <CardHeading title="The tax bomb" label="Deductions at risk" ember />
          <dd className={styles.figure}>
            <Money paise={totals.deductionsAtRiskPaise} withShort />
            <span className={styles.rule}>IT-43BH</span>
          </dd>
        </div>
        <div className={styles.card}>
          <CardHeading title="The graveyard" label="Counts" />
          <dd className={styles.figure}>
            <span className={styles.value}>
              {`Exploded ${totals.explodedCount} · Resurrected ${totals.paidCount}`}
            </span>
          </dd>
        </div>
      </dl>
      <p className={styles.asOf}>
        {rulesAsOf === null ? missing : `Rules as of ${formatDisplayDate(rulesAsOf)}`}
      </p>
    </section>
  );
}
