/** Banshee mark for the generated icons: a bone ghost with a spectral outline on the --sky-mid ground. */
export const MARK_BACKGROUND = "#0c0a14";

/** `size` is the square edge in px; the glyph keeps a fixed margin of one eighth on each side. */
export function GhostMark({ size }: { size: number }) {
  const glyph = Math.round(size * 0.75);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: MARK_BACKGROUND,
      }}
    >
      <svg width={glyph} height={glyph} viewBox="0 0 32 32">
        <path
          d="M16 3C9.5 3 6 8 6 14V29L9.5 26L13 29L16 26L19 29L22.5 26L26 29V14C26 8 22.5 3 16 3Z"
          fill="#ece7db"
          stroke="#7ce8c0"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <ellipse cx="12.5" cy="14" rx="2" ry="2.8" fill="#0c0a14" />
        <ellipse cx="19.5" cy="14" rx="2" ry="2.8" fill="#0c0a14" />
        <ellipse cx="16" cy="20" rx="1.8" ry="2.4" fill="#0c0a14" />
      </svg>
    </div>
  );
}
