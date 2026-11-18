// @vitest-environment jsdom
// SendControls and "Start call" as the Debtor_Page renders them for one invoice. The send actions are mocked
// (the real ones are server-only); the component, the server-side builder `buildSendControls` and the wa.me
// URL builder are the real code. Every phone number here is fictional.
// Requirements: 4.1, 4.3, 4.4, 4.5, 4.7, 4.8, 4.9, 8.5, 9.8
import { waMeUrl, parseE164 } from "@dues-banshee/agent";
import type { InvoiceSendState, SendableDraftRow } from "@dues-banshee/db";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendPayLink: vi.fn(), openInWhatsApp: vi.fn() }));
vi.mock("@/app/(debtor)/debtors/[id]/send-actions", () => ({
  sendPayLink: mocks.sendPayLink,
  openInWhatsApp: mocks.openInWhatsApp,
}));

import { PlaceholderActions } from "@/components/debtor/placeholder-actions";
import { SendControls } from "@/components/debtor/send-controls";
import { buildSendControls } from "@/lib/debtor/build-send-controls";

const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "00000000-0000-4000-8000-0000000000d1";
const AMOUNT_PAISE = 41_200_000;
/** Fictional number (+91 900000xxxx is not a real subscriber range). */
const BUYER_NUMBER = "+919000000001";

const BASIS_LINE = "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)";
const DISCLAIMER = "Reminders a supplier sends to its own buyers. Not legal advice.";
const PLAIN_BODY = "Namaste Sharma ji, yeh ek vinamra reminder hai.";
const MARKER_BODY = "Namaste Sharma ji. Kripya [payment link added on send] se bhugtan kar dein.";

const SENT_TEXT = "Queued with Twilio. Delivery is not tracked.";
const HANDED_OFF_TEXT = "Opened in WhatsApp. Tap Send on your phone.";

function draftRow(bodyText: string): SendableDraftRow {
  return {
    draftId: DRAFT_ID,
    step: "whatsapp_nudge",
    approvalDay: "2026-11-12",
    createdAt: new Date(1000),
    bodyText,
    ruleIds: ["MSMED-15", "MSMED-16"],
  };
}

interface DataOptions {
  bodyText?: string | null;
  buyerNumberSet?: boolean;
  twilioReady?: boolean;
  lastSent?: InvoiceSendState["lastSent"];
  override?: "2026-11-12" | null;
}

function dataFor({
  bodyText = PLAIN_BODY,
  buyerNumberSet = true,
  twilioReady = true,
  lastSent = null,
  override = null,
}: DataOptions = {}) {
  const state: InvoiceSendState = {
    invoiceId: INVOICE_ID,
    sendableDrafts: bodyText === null ? [] : [draftRow(bodyText)],
    lastSent,
  };
  return buildSendControls({ state, amountPaise: AMOUNT_PAISE, buyerNumberSet, twilioReady, override });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.sendPayLink.mockReset();
  mocks.openInWhatsApp.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

async function mount(options: DataOptions = {}): Promise<void> {
  const data = dataFor(options);
  await act(async () => {
    root.render(<SendControls data={data} />);
  });
}

function button(label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label) ?? null;
}

function mustButton(label: string): HTMLButtonElement {
  const found = button(label);
  if (found === null) throw new Error(`no "${label}" button`);
  return found;
}

/** The text the button's `aria-describedby` points to, or null when it has none. */
function reasonOf(el: HTMLElement): string | null {
  const id = el.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

async function submit(label: string): Promise<void> {
  const form = mustButton(label).closest("form");
  if (form === null) throw new Error(`"${label}" is not in a form`);
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A stand-in for the blank tab SendControls opens inside the click. */
function fakeTab() {
  return { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
}

function stubOpen(tab: ReturnType<typeof fakeTab> | null) {
  return vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window | null);
}

describe("Send pay link states (Req 4.1, 4.3, 4.4, 4.5)", () => {
  it("no_draft: disabled with 'Approve a WhatsApp draft first', no Open in WhatsApp, no preview, no hidden fields", async () => {
    await mount({ bodyText: null });

    const send = mustButton("Send pay link");
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-describedby")).toBe(`send-note-${INVOICE_ID}`);
    expect(reasonOf(send)).toBe("Approve a WhatsApp draft first");
    expect(button("Open in WhatsApp")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });

  it("no_number: disabled with 'No WhatsApp number for this buyer'; Open in WhatsApp enabled; preview shown", async () => {
    await mount({ buyerNumberSet: false });

    const send = mustButton("Send pay link");
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-describedby")).toBe(`send-note-${INVOICE_ID}`);
    expect(reasonOf(send)).toBe("No WhatsApp number for this buyer");
    expect(mustButton("Open in WhatsApp").disabled).toBe(false);
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("no_number takes precedence over an unconfigured sender", async () => {
    await mount({ buyerNumberSet: false, twilioReady: false });

    expect(reasonOf(mustButton("Send pay link"))).toBe("No WhatsApp number for this buyer");
  });

  it("sender_not_configured: disabled with 'WhatsApp sender not configured'; Open in WhatsApp enabled", async () => {
    await mount({ twilioReady: false });

    const send = mustButton("Send pay link");
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-describedby")).toBe(`send-note-${INVOICE_ID}`);
    expect(reasonOf(send)).toBe("WhatsApp sender not configured");
    expect(mustButton("Open in WhatsApp").disabled).toBe(false);
  });

  it("ready: both buttons enabled, no reason text and no aria-describedby", async () => {
    await mount();

    const send = mustButton("Send pay link");
    expect(send.disabled).toBe(false);
    expect(send.hasAttribute("aria-describedby")).toBe(false);
    expect(document.getElementById(`send-note-${INVOICE_ID}`)).toBeNull();
    expect(mustButton("Open in WhatsApp").disabled).toBe(false);
    expect(send.getAttribute("type")).toBe("submit");
  });

  it("posts only the Draft id, plus the Demo_Override as `today` when there is one", async () => {
    mocks.sendPayLink.mockResolvedValue({ invoiceId: INVOICE_ID, text: SENT_TEXT, role: "status" });
    await mount();
    await submit("Send pay link");
    const plain = mocks.sendPayLink.mock.calls[0]![1] as FormData;
    expect(Array.from(plain.entries())).toEqual([["draftId", DRAFT_ID]]);

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    mocks.sendPayLink.mockClear();
    await mount({ override: "2026-11-12" });
    await submit("Send pay link");
    const withOverride = mocks.sendPayLink.mock.calls[0]![1] as FormData;
    expect(Array.from(withOverride.entries())).toEqual([
      ["draftId", DRAFT_ID],
      ["today", "2026-11-12"],
    ]);
  });
});

describe("Outbound_Text preview (Req 4.1)", () => {
  it("a body with no marker gets the Pay_Link_Line with '<link created on send>', then the Basis_Line and Disclaimer", async () => {
    await mount({ bodyText: PLAIN_BODY });

    expect(container.querySelector("pre")?.textContent).toBe(
      `${PLAIN_BODY}\n\nPay ₹4,12,000 here: <link created on send>\n\n${BASIS_LINE}\n${DISCLAIMER}`,
    );
  });

  it("a body with the marker shows '<link created on send>' in its place and no Pay_Link_Line", async () => {
    await mount({ bodyText: MARKER_BODY });

    expect(container.querySelector("pre")?.textContent).toBe(
      `Namaste Sharma ji. Kripya <link created on send> se bhugtan kar dein.\n\n${BASIS_LINE}\n${DISCLAIMER}`,
    );
    expect(container.querySelector("pre")?.textContent).not.toContain("[payment link added on send]");
    expect(container.querySelector("pre")?.textContent).not.toContain("Pay ₹");
  });
});

describe("pending state (Req 4.8)", () => {
  it("disables both buttons from a Twilio submit until the action returns, then shows one status", async () => {
    const inFlight = deferred<{ invoiceId: string; text: string; role: "status" }>();
    mocks.sendPayLink.mockImplementationOnce(() => inFlight.promise);
    await mount();

    await submit("Send pay link");

    expect(mustButton("Send pay link").disabled).toBe(true);
    expect(mustButton("Open in WhatsApp").disabled).toBe(true);
    expect(container.querySelector("[role]")).toBeNull();

    await act(async () => {
      inFlight.resolve({ invoiceId: INVOICE_ID, text: SENT_TEXT, role: "status" });
      await inFlight.promise;
    });

    expect(mustButton("Send pay link").disabled).toBe(false);
    expect(mustButton("Open in WhatsApp").disabled).toBe(false);
    const results = container.querySelectorAll("[role]");
    expect(results).toHaveLength(1);
    expect(results[0]!.getAttribute("role")).toBe("status");
    expect(results[0]!.textContent).toBe(SENT_TEXT);
  });

  it("disables both buttons while an Open in WhatsApp submit is in flight", async () => {
    stubOpen(fakeTab());
    const inFlight = deferred<{ invoiceId: string; text: string; role: "status" }>();
    mocks.openInWhatsApp.mockImplementationOnce(() => inFlight.promise);
    await mount();

    await submit("Open in WhatsApp");

    expect(mustButton("Send pay link").disabled).toBe(true);
    expect(mustButton("Open in WhatsApp").disabled).toBe(true);

    await act(async () => {
      inFlight.resolve({ invoiceId: INVOICE_ID, text: HANDED_OFF_TEXT, role: "status" });
      await inFlight.promise;
    });
    expect(mustButton("Send pay link").disabled).toBe(false);
    expect(mustButton("Open in WhatsApp").disabled).toBe(false);
  });

  it("a failure from the action shows exactly one message with role=alert", async () => {
    mocks.sendPayLink.mockResolvedValue({ invoiceId: INVOICE_ID, text: "This draft can't be sent", role: "alert" });
    await mount();

    await submit("Send pay link");

    const results = container.querySelectorAll("[role]");
    expect(results).toHaveLength(1);
    expect(results[0]!.getAttribute("role")).toBe("alert");
    expect(results[0]!.textContent).toBe("This draft can't be sent");
  });
});

describe("Open in WhatsApp (Req 4.2, 4.4)", () => {
  // Text of a fixed Outbound_Text, percent-encoded as UTF-8 (₹ is E2 82 B9, the line break is %0A).
  const TEXT = "Namaste Sharma ji\nPay ₹4,12,000 here: https://rzp.io/i/demo";
  const ENCODED = "Namaste%20Sharma%20ji%0APay%20%E2%82%B94%2C12%2C000%20here%3A%20https%3A%2F%2Frzp.io%2Fi%2Fdemo";

  it("points the opened tab at https://wa.me/<digits>?text=<encoded> for a fixed number and text", async () => {
    const url = waMeUrl(parseE164(BUYER_NUMBER), TEXT);
    expect(url).toBe(`https://wa.me/919000000001?text=${ENCODED}`);
    mocks.openInWhatsApp.mockResolvedValue({ invoiceId: INVOICE_ID, text: HANDED_OFF_TEXT, role: "status", url });
    const tab = fakeTab();
    const open = stubOpen(tab);
    await mount();

    await submit("Open in WhatsApp");

    expect(open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe(`https://wa.me/919000000001?text=${ENCODED}`);
    expect(tab.close).not.toHaveBeenCalled();
    expect(container.querySelector("[role]")?.getAttribute("role")).toBe("status");
    expect(container.querySelector("[role]")?.textContent).toBe(HANDED_OFF_TEXT);
    expect(mocks.sendPayLink).not.toHaveBeenCalled();
  });

  it("opens https://wa.me/?text=<encoded> when the buyer has no number", async () => {
    const url = waMeUrl(null, TEXT);
    expect(url).toBe(`https://wa.me/?text=${ENCODED}`);
    mocks.openInWhatsApp.mockResolvedValue({ invoiceId: INVOICE_ID, text: HANDED_OFF_TEXT, role: "status", url });
    const tab = fakeTab();
    stubOpen(tab);
    await mount({ buyerNumberSet: false });

    await submit("Open in WhatsApp");

    expect(tab.location.href).toBe(`https://wa.me/?text=${ENCODED}`);
  });

  it("closes the blank tab and shows an alert when the checks fail", async () => {
    mocks.openInWhatsApp.mockResolvedValue({ invoiceId: INVOICE_ID, text: "Payments are not configured", role: "alert" });
    const tab = fakeTab();
    stubOpen(tab);
    await mount();

    await submit("Open in WhatsApp");

    expect(tab.location.href).toBe("");
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role]")?.getAttribute("role")).toBe("alert");
    expect(container.querySelector("[role]")?.textContent).toBe("Payments are not configured");
  });

  it("offers a plain link to the same URL when the browser blocks the new tab", async () => {
    const url = `https://wa.me/919000000001?text=${ENCODED}`;
    mocks.openInWhatsApp.mockResolvedValue({ invoiceId: INVOICE_ID, text: HANDED_OFF_TEXT, role: "status", url });
    stubOpen(null);
    await mount();

    await submit("Open in WhatsApp");

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(url);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.textContent).toBe("Open the WhatsApp link");
  });
});

describe("Sent line (Req 4.7)", () => {
  it("shows 'Sent on 12 Nov 2026 via Twilio sandbox' and, with no draft left, the no_draft controls", async () => {
    await mount({ bodyText: null, lastSent: { channel: "twilio_sandbox", sentOn: "2026-11-12" } });

    expect(container.textContent).toContain("Sent on 12 Nov 2026 via Twilio sandbox");
    expect(container.querySelectorAll("p")[0]?.textContent).toBe("Sent on 12 Nov 2026 via Twilio sandbox");
    expect(reasonOf(mustButton("Send pay link"))).toBe("Approve a WhatsApp draft first");
    expect(button("Open in WhatsApp")).toBeNull();
  });

  it("shows 'Sent on 12 Nov 2026 via your WhatsApp' for a wa.me hand-off", async () => {
    await mount({ bodyText: null, lastSent: { channel: "wa_me", sentOn: "2026-11-12" } });

    expect(container.querySelectorAll("p")[0]?.textContent).toBe("Sent on 12 Nov 2026 via your WhatsApp");
  });

  it("shows no sent line when nothing was sent", async () => {
    await mount();

    expect(container.textContent).not.toContain("Sent on");
  });
});

describe("Start call placeholder (Req 4.9)", () => {
  it("stays disabled with 'Arrives with voice call'", async () => {
    await act(async () => {
      root.render(<PlaceholderActions invoiceId={INVOICE_ID} />);
    });

    const call = mustButton("Start call");
    expect(call.disabled).toBe(true);
    expect(call.getAttribute("type")).toBe("button");
    expect(call.getAttribute("aria-describedby")).toBe(`start-call-note-${INVOICE_ID}`);
    expect(reasonOf(call)).toBe("Arrives with voice call");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("form")).toBeNull();
  });
});
