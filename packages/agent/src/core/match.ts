/** Lowercase, then every run of whitespace (incl. \n, \t) becomes one space. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ");
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Whole-word, case-insensitive regex for one phrase: every special character is escaped,
 * inner whitespace becomes a single space, and the phrase must not touch a letter or digit
 * (any script) on either side. Non-global, so it carries no `lastIndex` state.
 */
export function phraseRegex(phrase: string): RegExp {
  const body = phrase
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(REGEX_SPECIALS, "\\$&"))
    .join(" ");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
}
