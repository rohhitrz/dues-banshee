import { createHash, timingSafeEqual } from "node:crypto";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compares SHA-256 digests, so both buffers have equal length and the comparison is constant-time. */
export function bearerMatches(header: string | null, secret: string): boolean {
  const match = header === null ? null : /^Bearer (.+)$/.exec(header);
  const presented = match?.[1] ?? "";
  return timingSafeEqual(sha256(presented), sha256(secret)) && presented.length > 0;
}
