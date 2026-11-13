import Link from "next/link";
import styles from "./not-found.module.css";

/** Themed 404. Renders inside the root-layout App_Shell. Fixed text only (Req 1.5). */
export default function NotFound() {
  return (
    <main className={styles.page}>
      <p className={styles.mark} aria-hidden="true">
        R.I.P.
      </p>
      <h1 className={styles.title}>This grave is empty</h1>
      <p className={styles.message}>The page you were looking for is not buried here.</p>
      <Link className={styles.link} href="/">
        Back to the graveyard
      </Link>
    </main>
  );
}
