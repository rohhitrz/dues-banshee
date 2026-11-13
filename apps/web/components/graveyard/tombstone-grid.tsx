import type { CalendarDate } from "@dues-banshee/engine";
import type { TombstoneView } from "@/lib/graveyard/build-graveyard";
import { GraveyardScene } from "./graveyard-scene";
import { Tombstone } from "./tombstone";
import styles from "./tombstone-grid.module.css";

export interface TombstoneGridProps {
  tombstones: readonly TombstoneView[];
  today: CalendarDate;
}

/** The scene sits in a layer behind the list; the list is above it, so no decoration covers any text. */
export function TombstoneGrid({ tombstones, today }: TombstoneGridProps) {
  return (
    <div className={styles.stage}>
      <GraveyardScene />
      <ul className={styles.grid}>
        {tombstones.map((view) => (
          <Tombstone key={view.id} view={view} today={today} />
        ))}
      </ul>
    </div>
  );
}
