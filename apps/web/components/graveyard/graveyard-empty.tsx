import Link from "next/link";
import styles from "./graveyard-empty.module.css";

/** Empty state: shown when the graveyard has no tombstones (Req 8.1). */
export function GraveyardEmpty() {
  return (
    <section className={styles.empty}>
      <p className={styles.title}>The graveyard is quiet</p>
      <Link className={styles.link} href="/import">
        Import invoices
      </Link>
    </section>
  );
}
