import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks the `X-Razorpay-Signature` header: the hex HMAC-SHA256 of the raw request text keyed with
 * the webhook secret. A missing signature is invalid. Lengths are compared first because
 * `timingSafeEqual` throws on unequal lengths; the comparison itself is constant time (Req 6.2, 6.11).
 */
export function razorpaySignatureValid(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (signature === null) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
