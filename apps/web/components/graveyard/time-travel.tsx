import Link from "next/link";
import type { CalendarDate } from "@dues-banshee/engine";
import { TIME_TRAVEL_PRESETS, formatDisplayDate } from "@/lib/graveyard/today";
import styles from "./time-travel.module.css";

export interface TimeTravelProps {
  /** The accepted `?today=` value, or null when Today is the real IST date. */
  override: CalendarDate | null;
}

export function TimeTravel({ override }: TimeTravelProps) {
  return (
    <nav className={styles.wrap} aria-label="Time travel">
      <ul className={styles.list}>
        {TIME_TRAVEL_PRESETS.map((preset) => (
          <li key={preset.label}>
            <Link
              className={styles.link}
              href={preset.today === null ? "/" : `/?today=${preset.today}`}
              aria-current={preset.today === override ? "page" : undefined}
            >
              {preset.label}
            </Link>
          </li>
        ))}
      </ul>
      {override === null ? null : (
        <p className={styles.chip}>{`Demo date: ${formatDisplayDate(override)}`}</p>
      )}
    </nav>
  );
}
