/**
 * Masks a phone number for logs: same length, the last four digits kept, every other character
 * (including `+`, spaces and any `whatsapp:` prefix) replaced by `*` (Req 5.6, 7.3).
 */
export function maskNumber(n: string): string {
  const chars = Array.from(n, () => "*");
  const source = Array.from(n);
  let kept = 0;
  for (let i = source.length - 1; i >= 0 && kept < 4; i--) {
    const c = source[i];
    if (c !== undefined && c >= "0" && c <= "9") {
      chars[i] = c;
      kept++;
    }
  }
  return chars.join("");
}
