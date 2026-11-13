import Link from "next/link";
import styles from "./load-error.module.css";

export interface LoadErrorProps {
  /** The raw `today` query value, if one was given. It is URL-encoded into the retry link. */
  todayRaw?: string | undefined;
}

/** Calm error view. Fixed text only: it never receives or renders any error data (Req 11.2). */
export function LoadError({ todayRaw }: LoadErrorProps) {
  const href = todayRaw === undefined ? "/" : `/?today=${encodeURIComponent(todayRaw)}`;
  return (
    <section className={styles.error} role="alert">
      <p className={styles.message}>We couldn&apos;t load your graveyard just now. Please try again.</p>
      <Link className={styles.retry} href={href}>
        Try again
      </Link>
    </section>
  );
}
