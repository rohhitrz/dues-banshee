import Link from "next/link";
import type { CalendarDate } from "@dues-banshee/engine";
import styles from "./debtor-load-error.module.css";

export interface DebtorLoadErrorProps {
  /** The Buyer_Id from the URL path, as already validated by the page. */
  buyerId: string;
  /** The active Demo_Override, carried into the retry link, or null. */
  override: CalendarDate | null;
}

/** Calm error view. Fixed text only: it never receives or renders any error data. */
export function DebtorLoadError({ buyerId, override }: DebtorLoadErrorProps) {
  const base = `/debtors/${encodeURIComponent(buyerId)}`;
  const href = override === null ? base : `${base}?today=${encodeURIComponent(override)}`;
  return (
    <section className={styles.error} role="alert">
      <p className={styles.message}>We couldn&apos;t load this buyer just now. Please try again.</p>
      <Link className={styles.retry} href={href}>
        Try again
      </Link>
    </section>
  );
}
