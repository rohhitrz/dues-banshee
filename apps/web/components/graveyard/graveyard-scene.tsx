import styles from "./graveyard-scene.module.css";

const STARS: readonly { x: number; y: number; r: number }[] = [
  { x: 40, y: 30, r: 1.2 },
  { x: 120, y: 80, r: 1 },
  { x: 210, y: 24, r: 1.4 },
  { x: 300, y: 64, r: 1 },
  { x: 390, y: 36, r: 1.2 },
  { x: 480, y: 90, r: 1 },
  { x: 560, y: 28, r: 1.4 },
  { x: 650, y: 70, r: 1 },
  { x: 740, y: 40, r: 1.2 },
  { x: 820, y: 96, r: 1 },
  { x: 900, y: 30, r: 1.4 },
  { x: 990, y: 62, r: 1 },
  { x: 1080, y: 34, r: 1.2 },
  { x: 1160, y: 84, r: 1 },
];

const BAT_PATH =
  "M17 8c-2-3-5-5-9-4 1 1 1 3 0 4-2-1-5-1-8 1 3 0 5 2 6 4 2-2 6-3 11-1 5-2 9-1 11 1 1-2 3-4 6-4-3-2-6-2-8-1-1-1-1-3 0-4-4-1-7 1-9 4z";

const TREE_PATH =
  "M60 200 L60 120 L40 90 M60 120 L84 84 M60 150 L30 128 M60 140 L92 118 M40 90 L26 66 M84 84 L90 56 M40 90 L52 62";

/** Decorative background only: inline SVG and CSS, no canvas or WebGL. The parent must be position: relative. */
export function GraveyardScene() {
  return (
    <div className={styles.scene} aria-hidden="true">
      <svg className={styles.stars} viewBox="0 0 1200 120" preserveAspectRatio="xMidYMin slice">
        {STARS.map((s) => (
          <circle key={`${s.x}-${s.y}`} cx={s.x} cy={s.y} r={s.r} fill="#ece7db" />
        ))}
      </svg>
      <span className={styles.moon} />
      <svg className={`${styles.tree} ${styles.treeLeft}`} viewBox="0 0 120 200">
        <path d={TREE_PATH} />
      </svg>
      <svg className={`${styles.tree} ${styles.treeRight}`} viewBox="0 0 120 200">
        <path d={TREE_PATH} />
      </svg>
      <svg className={`${styles.bat} ${styles.batA}`} width="34" height="14" viewBox="0 0 34 14">
        <path d={BAT_PATH} />
      </svg>
      <svg className={`${styles.bat} ${styles.batB}`} width="24" height="10" viewBox="0 0 34 14">
        <path d={BAT_PATH} />
      </svg>
      <div className={styles.ground}>
        <span className={`${styles.fog} ${styles.fogA}`} />
        <span className={`${styles.fog} ${styles.fogB}`} />
        <svg className={styles.fence} width="100%" height="40">
          <defs>
            <pattern id="graveyard-fence" width="20" height="40" patternUnits="userSpaceOnUse">
              <path d="M4 40 L4 8 L7 2 L10 8 L10 40 M0 18 L20 18" />
            </pattern>
          </defs>
          <rect width="100%" height="40" fill="url(#graveyard-fence)" />
        </svg>
      </div>
    </div>
  );
}
