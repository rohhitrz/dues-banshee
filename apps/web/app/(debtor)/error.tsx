"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { isValidTodayOverride } from "@/lib/graveyard/today";
import styles from "@/components/debtor/debtor-load-error.module.css";

/**
 * Backstop for render errors under `(debtor)`. The error prop is deliberately never read: the markup
 * is fixed text plus a retry link to the same path, so no message, stack, name or digest can reach the
 * page. The only inputs are the pathname and the `today` query value, which keeps a demo date on the
 * retry link only when it is a valid override (the same check `resolveToday` applies); anything else is dropped.
 */
export default function DebtorError() {
  const pathname = usePathname();
  const today = useSearchParams().get("today");
  const href = isValidTodayOverride(today) ? `${pathname}?today=${today}` : pathname;
  return (
    <main>
      <section className={styles.error} role="alert">
        <p className={styles.message}>We couldn&apos;t load this buyer just now. Please try again.</p>
        <Link className={styles.retry} href={href}>
          Try again
        </Link>
      </section>
    </main>
  );
}
