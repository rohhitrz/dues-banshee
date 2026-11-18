// Feature: whatsapp-channel, Property 6: Razorpay signature check
// Validates: Requirements 6.2, 6.11
import { createHmac } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { razorpaySignatureValid } from "../src/webhooks/razorpay-signature";

const sign = (body: string, secret: string): string => createHmac("sha256", secret).update(body, "utf8").digest("hex");

const SPECIAL = ["₹", "नमस्ते", "🙂", "ñ", "\n", "\r\n", "\u0000", "{", "}", '"', " "];
const arbBody = fc.oneof(
  fc.string({ unit: "grapheme" }),
  fc.array(fc.oneof(fc.constantFrom(...SPECIAL), fc.string({ unit: "grapheme", maxLength: 6 })), { maxLength: 12 }).map((p) => p.join("")),
);
const arbNonEmptyBody = arbBody.filter((b) => b.length > 0);
const arbSecret = fc.oneof(
  fc.string({ unit: "grapheme", minLength: 1 }),
  fc.constantFrom("whsec_test", "रहस्य", "🙂🙂", "a"),
);
const HEX = "0123456789abcdef";

describe("Property 6: Razorpay signature check", () => {
  it("accepts the correct hex HMAC-SHA256 signature for any Unicode body and non-empty secret", () => {
    fc.assert(
      fc.property(arbBody, arbSecret, (body, secret) => {
        const signature = sign(body, secret);
        expect(signature).toMatch(/^[0-9a-f]{64}$/);
        expect(razorpaySignatureValid(body, signature, secret)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a body with one character changed", () => {
    fc.assert(
      fc.property(arbNonEmptyBody, arbSecret, fc.nat(), (body, secret, at) => {
        const signature = sign(body, secret);
        const chars = Array.from(body);
        const i = at % chars.length;
        chars[i] = chars[i] === "a" ? "b" : "a";
        const mutated = chars.join("");
        expect(mutated).not.toEqual(body);
        expect(razorpaySignatureValid(mutated, signature, secret)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a signature with one hex digit changed", () => {
    fc.assert(
      fc.property(arbBody, arbSecret, fc.nat(63), fc.nat(14), (body, secret, at, shift) => {
        const signature = sign(body, secret);
        const original = HEX.indexOf(signature[at]!);
        const replacement = HEX[(original + 1 + shift) % 16]!;
        expect(replacement).not.toEqual(signature[at]);
        const mutated = signature.slice(0, at) + replacement + signature.slice(at + 1);
        expect(razorpaySignatureValid(body, mutated, secret)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a truncated or extended signature without throwing", () => {
    fc.assert(
      fc.property(
        arbBody,
        arbSecret,
        fc.integer({ min: 1, max: 64 }),
        fc.string({ unit: "grapheme", minLength: 1, maxLength: 8 }),
        (body, secret, cut, extra) => {
          const signature = sign(body, secret);
          expect(razorpaySignatureValid(body, signature.slice(0, 64 - cut), secret)).toBe(false);
          expect(razorpaySignatureValid(body, signature + extra, secret)).toBe(false);
          expect(razorpaySignatureValid(body, extra + signature, secret)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects a signature made with a different secret", () => {
    fc.assert(
      fc.property(arbBody, arbSecret, arbSecret, (body, secret, other) => {
        fc.pre(other !== secret);
        expect(razorpaySignatureValid(body, sign(body, other), secret)).toBe(false);
        expect(razorpaySignatureValid(body, sign(body, secret), `${secret}x`)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("rejects a null signature", () => {
    fc.assert(
      fc.property(arbBody, arbSecret, (body, secret) => {
        expect(razorpaySignatureValid(body, null, secret)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
