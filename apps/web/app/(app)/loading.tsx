import styles from "./loading.module.css";
export const LOADING_TEXT = "Raising the dead…";
/**
 * Shown while `/` first loads, including right after sign-in. It sits inside the App_Shell (the root
 * layout), so the nav and footer stay. A `searchParams`-only change does not show this file: Next keeps
 * the old page until the new one is ready, which the Time_Travel_Control covers with its own pending state.
 */
export default function Loading() {
  return (
    <main className={styles.page} aria-busy="true">
      <h1 className={styles.title}>Graveyard of dues</h1>
      <p className={styles.status} role="status" aria-live="polite">
        {LOADING_TEXT}
      </p>
      <div className={styles.skeleton} aria-hidden="true">
        <ul className={styles.cards}>
          {[0, 1, 2, 3].map((n) => (
            <li key={n} className={styles.card} />
          ))}
        </ul>
        <ul className={styles.stones}>
          {[150, 230, 190, 280, 170].map((height, n) => (
            <li key={n} className={styles.stone} style={{ height: `${height}px` }} />
          ))}
        </ul>
      </div>
    </main>
  );
}
