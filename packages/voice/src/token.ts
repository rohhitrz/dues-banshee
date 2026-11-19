import { createHash, randomBytes } from "node:crypto";

/** Join_Token: 32 random bytes (256 bits), base64url, so it is safe in a URL path. */
export function generateJoinToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the token as 64 lowercase hex characters. Only this hash is ever stored or compared. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
