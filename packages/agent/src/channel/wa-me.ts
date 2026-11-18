import type { ChannelResult, E164, MessageChannel, SendRequest } from "./message-channel";

/** A surrogate that is not half of a valid pair. `encodeURIComponent` throws on these. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The wa.me click-to-send URL. The text is percent-encoded as UTF-8, so line breaks, `₹` and
 * Devanagari survive `decodeURIComponent` unchanged (Req 1.4). A lone surrogate cannot be encoded as
 * UTF-8, so it becomes U+FFFD instead of throwing. With no number the owner picks the contact (Req 4.4).
 */
export function waMeUrl(to: E164 | null, text: string): string {
  const digits = to === null ? "" : to.slice(1);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text.replace(LONE_SURROGATE, "\uFFFD"))}`;
}

/** The backup sender: makes no network call and returns the URL the owner opens (Req 1.4). */
export function createWaMeLink(): MessageChannel {
  return {
    name: "wa_me",
    send(req: SendRequest): Promise<ChannelResult> {
      return Promise.resolve({ kind: "handoff", url: waMeUrl(req.to, req.text) });
    },
  };
}
