// Feature: whatsapp-channel, Property 5: Phone numbers are masked in every log payload
// Validates: Requirements 5.6, 7.3
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskNumber } from "../src/channel/mask";
import type { ChannelResult, PollRecord } from "../src/channel/message-channel";
import { parseE164 } from "../src/channel/message-channel";
import { sendWhatsappPayload } from "../src/channel/send-draft";
import { waMeUrl } from "../src/channel/wa-me";
import { whatsappInboundPayload } from "../src/webhooks/twilio";

const NUM_RUNS = 150;

/** Fictional numbers matching `^\+[1-9][0-9]{7,14}$`. */
const arbNumber = fc
  .tuple(fc.integer({ min: 1, max: 9 }), fc.stringMatching(/^[0-9]{7,14}$/))
  .map(([first, rest]) => `+${first}${rest}`);

const last4 = (n: string): string => n.slice(-4);
const expectedMask = (n: string): string => "*".repeat(n.length - 4) + last4(n);

/** The strings a leaked number could take inside serialized JSON. */
function leaks(json: string, n: string, extra: readonly string[] = []): string[] {
  return [n, n.slice(1), ...extra].filter((needle) => json.includes(needle));
}

/** Free text that does not incidentally contain the number (or its digits), nor a wa.me link. */
const arbFreeText = (n: string): fc.Arbitrary<string> =>
  fc
    .oneof(
      fc.string({ unit: "grapheme", maxLength: 80 }),
      fc.string({ unit: "grapheme", maxLength: 40 }).map((s) => `नमस्ते ₹4,12,000 ${s}\n`),
    )
    .filter((s) => !s.includes(n.slice(1)) && !s.includes("wa.me"));

/** An id-like token (SID, error code) that does not contain the number's digits. */
const arbToken = (n: string): fc.Arbitrary<string> =>
  fc.stringMatching(/^[A-Za-z0-9]{0,34}$/).filter((s) => !s.includes(n.slice(1)));

const arbPoll = (n: string): fc.Arbitrary<PollRecord> =>
  fc.oneof(
    fc.record({
      status: fc.constantFrom("queued", "sending", "sent", "delivered", "read", "failed", "undelivered"),
      errorCode: fc.constantFrom("", "63015", "63016", "30008"),
    }),
    fc.record({
      error: fc.constantFrom("timeout" as const, "network" as const, "provider_error" as const),
      httpStatus: fc.option(fc.integer({ min: 100, max: 599 }), { nil: null }),
    }),
  ).filter((p) => !JSON.stringify(p).includes(n.slice(1)));

const arbResult = (n: string): fc.Arbitrary<ChannelResult> =>
  fc.oneof(
    fc.record({
      kind: fc.constant("sent" as const),
      providerMessageId: arbToken(n),
      polls: fc.array(arbPoll(n), { maxLength: 3 }),
    }),
    fc.constant({ kind: "handoff" as const, url: waMeUrl(parseE164(n), "Namaste") }),
    fc.record({
      kind: fc.constant("failed" as const),
      errorKind: fc.constantFrom(
        "sandbox_window" as const,
        "provider_error" as const,
        "timeout" as const,
        "network" as const,
        "no_recipient" as const,
      ),
      errorCode: fc.constantFrom("", "63015", "63016", "21211"),
      providerMessageId: fc.option(arbToken(n), { nil: null }),
      polls: fc.array(arbPoll(n), { maxLength: 3 }),
    }),
  );

describe("Property 5: Phone numbers are masked in every log payload", () => {
  it("maskNumber keeps the length and the last four digits, and turns every other character into *", () => {
    fc.assert(
      fc.property(arbNumber, fc.constantFrom("", "whatsapp:"), (n, prefix) => {
        const input = `${prefix}${n}`;
        const masked = maskNumber(input);
        expect(masked).toHaveLength(input.length);
        expect(masked.slice(-4)).toEqual(last4(n));
        expect(masked.slice(0, -4)).toMatch(/^\**$/);
        expect(masked).toEqual("*".repeat(input.length - 4) + last4(n));
        expect(masked.includes(n.slice(1))).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("send_whatsapp payloads never hold the number, its digits or the wa.me URL, and show the masked form", () => {
    fc.assert(
      fc.property(
        arbNumber.chain((n) =>
          fc.record({
            n: fc.constant(n),
            text: arbFreeText(n),
            result: arbResult(n),
            channel: fc.constantFrom("twilio_sandbox" as const, "wa_me" as const),
            invoiceId: fc.uuid(),
            draftId: fc.uuid(),
          }),
        ),
        ({ n, text, result, channel, invoiceId, draftId }) => {
          const payload = sendWhatsappPayload({ invoiceId, draftId, channel, text, buyerNumber: n, result });
          const json = JSON.stringify(payload);
          const url = result.kind === "handoff" ? [result.url] : [];

          expect(leaks(json, n, url)).toEqual([]);
          expect(json).not.toContain("https://wa.me/");
          expect(payload.input["to"]).toEqual(expectedMask(n));
          expect(json).toContain(expectedMask(n));
          if (result.kind === "handoff") expect(payload.output).toEqual({ kind: "handoff" });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("send_whatsapp payloads log a null recipient as null (WaMe_Link without a buyer number)", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), arbFreeText("+10000000000"), (invoiceId, draftId, text) => {
        const payload = sendWhatsappPayload({
          invoiceId,
          draftId,
          channel: "wa_me",
          text,
          buyerNumber: null,
          result: { kind: "handoff", url: waMeUrl(null, text) },
        });
        expect(payload.input["to"]).toBeNull();
        expect(payload.output).toEqual({ kind: "handoff" });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("whatsapp_inbound payloads keep only the last four digits of a whatsapp:-prefixed sender", () => {
    fc.assert(
      fc.property(
        arbNumber.chain((n) =>
          fc.record({
            n: fc.constant(n),
            body: arbFreeText(n),
            sid: fc.stringMatching(/^SM[0-9a-f]{32}$/).filter((s) => !s.includes(n.slice(1))),
          }),
        ),
        ({ n, body, sid }) => {
          const payload = whatsappInboundPayload({ From: `whatsapp:${n}`, MessageSid: sid, Body: body });
          expect(payload.from).toEqual(expectedMask(n));

          const json = JSON.stringify(payload);
          expect(leaks(json, n)).toEqual([]);
          expect(json).toContain(expectedMask(n));
          expect(payload.untrusted.body).toEqual(body);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
