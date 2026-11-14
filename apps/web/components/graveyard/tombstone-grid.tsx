import type { CalendarDate } from "@dues-banshee/engine";
import type { TombstoneView } from "@/lib/graveyard/build-graveyard";
import { GraveyardLegend } from "./graveyard-legend";
import { GraveyardScene } from "./graveyard-scene";
import { Tombstone } from "./tombstone";
import styles from "./tombstone-grid.module.css";

export interface TombstoneGridProps {
  tombstones: readonly TombstoneView[];
  today: CalendarDate;
  /** The active Demo_Override, or null. */
  override?: CalendarDate | null;
}

/**
 * The scene sits in a layer behind the list; the list is above it, so no decoration covers any text.
 * The legend is one line under the stage, so it never sits on the scene.
 */
export function TombstoneGrid({ tombstones, today, override = null }: TombstoneGridProps) {
  return (
    <>
      <div className={styles.stage}>
        <GraveyardScene />
        <ul className={styles.grid}>
          {tombstones.map((view) => (
            <Tombstone key={view.id} view={view} today={today} override={override} />
          ))}
        </ul>
      </div>
      <GraveyardLegend />
    </>
  );
}
