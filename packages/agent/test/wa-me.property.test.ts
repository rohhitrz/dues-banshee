// Feature: whatsapp-channel, Property 2: WaMe_Link URL round trip
// Validates: Requirements 1.4, 4.4
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseE164 } from "../src/channel/message-channel";
import { createWaMeLink, waMeUrl } from "../src/channel/wa-me";

afterEach(() => {
  vi.unstubAllGlobals();
});

const arbE164 = fc
  .tuple(fc.integer({ min: 1, max: 9 }), fc.stringMatching(/^[0-9]{7,14}$/))
  .map(([first, rest]) => parseE164(`+${first}${rest}`))
  .filter((n) => n !== null);

const SPECIAL = ["\n", "\r\n", "₹", "नमस्ते", "&", "?", "#", "+", "%", " ", "=", "/", "ñ", "🙂", "%41", "text=x"];
const arbText = fc.oneof(
  fc.string({ unit: "grapheme" }),
  fc.array(fc.constantFrom(...SPECIAL), { maxLength: 20 }).map((parts) => parts.join("")),
  fc.array(fc.oneof(fc.constantFrom(...SPECIAL), fc.string({ maxLength: 8 })), { maxLength: 10 }).map((p) => p.join("")),
);

describe("Property 2: WaMe_Link URL round trip", () => {
  it("is wa.me/<digits>?text=<encoded> and decodes back to the exact text", () => {
    fc.assert(
      fc.property(fc.option(arbE164, { nil: null }), arbText, (to, text) => {
        const url = waMeUrl(to, text);
        const prefix = to === null ? "https://wa.me/?text=" : `https://wa.me/${to.slice(1)}?text=`;
        expect(url.startsWith(prefix)).toBe(true);
        const encoded = url.slice(prefix.length);
        expect(decodeURIComponent(encoded)).toEqual(text);
        // Exactly one query parameter, nothing after it, and no raw separator inside the encoded text.
        expect(encoded).not.toMatch(/[&#?+\s]/);
        const parsed = new URL(url);
        expect([...parsed.searchParams.keys()]).toEqual(["text"]);
        expect(parsed.searchParams.get("text")).toEqual(text);
        expect(parsed.hash).toEqual("");
      }),
      { numRuns: 200 },
    );
  });

  it("makes no network call and returns a handoff with the same URL", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const channel = createWaMeLink();
    expect(channel.name).toBe("wa_me");
    await fc.assert(
      fc.asyncProperty(fc.option(arbE164, { nil: null }), arbText, async (to, text) => {
        const result = await channel.send({ to, text, idempotencyKey: "draft-1" });
        expect(result).toEqual({ kind: "handoff", url: waMeUrl(to, text) });
      }),
      { numRuns: 100 },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("waMeUrl examples", () => {
  it("encodes the demo number, line breaks, rupee sign and Devanagari exactly", () => {
    const to = parseE164("+919000000001");
    expect(waMeUrl(to, "Namaste\n₹4,12,000 नमस्ते")).toEqual(
      "https://wa.me/919000000001?text=Namaste%0A%E2%82%B94%2C12%2C000%20%E0%A4%A8%E0%A4%AE%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A5%87",
    );
    expect(waMeUrl(null, "a b")).toEqual("https://wa.me/?text=a%20b");
  });

  it("replaces a lone surrogate with U+FFFD instead of throwing", () => {
    expect(waMeUrl(null, "a\uD800b")).toEqual("https://wa.me/?text=a%EF%BF%BDb");
    expect(waMeUrl(null, "x\uDC00")).toEqual("https://wa.me/?text=x%EF%BF%BD");
    expect(waMeUrl(null, "🙂")).toEqual("https://wa.me/?text=%F0%9F%99%82");
  });
});
