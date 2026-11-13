import type { ReactNode } from "react";
import styles from "./graveyard-legend.module.css";
const ENTRIES: readonly { key: string; text: string; icon: ReactNode }[] = [
  { key: "height", text: "Taller stone = more owed", icon: <span className={styles.stone} /> },
  { key: "moss", text: "Moss = days overdue", icon: <span className={styles.moss} /> },
  {
    key: "cracks",
    text: "Cracks = over 60 days",
    icon: (
      <svg className={styles.cracks} width="10" height="12" viewBox="0 0 10 12">
        <path d="M4 0 L6 4 L3 7 L6 12" />
      </svg>
    ),
  },
  { key: "ember", text: "Ember = over 45 days", icon: <span className={styles.ember} /> },
  { key: "wisp", text: "Wisp = promise to pay pending", icon: <span className={styles.wisp} /> },
];
/**
 * One compact line that names every encoding on the stones. The swatches are static, decorative and
 * aria-hidden; the meaning is in the text, which is the same text for every viewer.
 */
export function GraveyardLegend() {
  return (
    <ul className={styles.legend} aria-label="How to read the stones">
      {ENTRIES.map((entry, index) => (
        <li key={entry.key} className={styles.entry}>
          <span className={styles.icon} aria-hidden="true">
            {entry.icon}
          </span>
          {entry.text}
          {index < ENTRIES.length - 1 ? (
            <span className={styles.sep} aria-hidden="true">
              {" · "}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
