// @vitest-environment jsdom
// "Start call" as the Debtor_Page renders it for one invoice. The `startCall` server action is mocked (the
// real one is server-only); the component, the server-side builder `buildStartCallControls` and the copy
// constants are the real code. Any request the test does not mock fails through the global fetch guard.
// Requirements: 1.1, 1.2, 1.3, 1.9, 1.15, 1.16, 10.1, 11.7
import { DISCLAIMER } from "@dues-banshee/agent";
import { DEMO_SUPPLIER } from "@dues-banshee/db";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ startCall: vi.fn() }));
vi.mock("@/app/(debtor)/debtors/[id]/call-actions", () => ({ startCall: mocks.startCall }));

import { StartCallControls } from "@/components/debtor/start-call-controls";
import {
  CALL_COPY,
  CALL_DISCLAIMER,
  DEMO_HOURS_TEXT,
  NOT_CALLABLE_TEXT,
  NOT_CONFIGURED_TEXT,
} from "@/lib/call/call-copy";
import { CALL_LINK_READY_TEXT } from "@/lib/call/start-call";
import { buildStartCallControls, type StartCallControlsData } from "@/lib/debtor/build-start-call-controls";

const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const CALL_URL = "https://dues.example/call/abc123token";
const WA_ME_URL = "https://wa.me/?text=Join%20the%20call";

const CALL_COPY_TEXT = "AI call over the internet. Phone (PSTN) calls are on the roadmap.";
const DISCLAIMER_TEXT = "Reminders a supplier sends to its own buyers. Not legal advice.";

function data(overrides: Partial<StartCallControlsData> = {}): StartCallControlsData {
  return { invoiceId: INVOICE_ID, callable: true, configured: true, isDemo: false, override: null, ...overrides };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.startCall.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

async function mount(overrides: Partial<StartCallControlsData> = {}): Promise<void> {
  await act(async () => {
    root.render(<StartCallControls data={data(overrides)} />);
  });
}

function startButton(): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Start call");
  if (found === undefined) throw new Error('no "Start call" button');
  return found;
}

/** The text the element's `aria-describedby` points to, or null when it has none. */
function reasonOf(el: HTMLElement): string | null {
  const id = el.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

async function submit(): Promise<void> {
  const form = startButton().closest("form");
  if (form === null) throw new Error('"Start call" is not in a form');
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("Start call states (Req 1.1, 1.2, 1.3)", () => {
  it("enabled: the button is enabled, with the Call_Copy and the Disclaimer and no reason text", async () => {
    await mount();

    const button = startButton();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(document.getElementById(`start-call-note-${INVOICE_ID}`)).toBeNull();
    expect(container.textContent).toContain(CALL_COPY_TEXT);
    expect(container.textContent).toContain(DISCLAIMER_TEXT);
    expect(container.textContent).not.toContain(NOT_CALLABLE_TEXT);
    expect(container.textContent).not.toContain(NOT_CONFIGURED_TEXT);
  });

  it("not callable: disabled, described by 'No call needed for this invoice'", async () => {
    await mount({ callable: false });

    const button = startButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(`start-call-note-${INVOICE_ID}`);
    expect(reasonOf(button)).toBe("No call needed for this invoice");
  });

  it("not configured: disabled, described by 'Voice calls not configured'", async () => {
    await mount({ configured: false });

    const button = startButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(`start-call-note-${INVOICE_ID}`);
    expect(reasonOf(button)).toBe("Voice calls not configured");
  });

  it("not configured wins over not callable", async () => {
    await mount({ configured: false, callable: false });

    expect(startButton().disabled).toBe(true);
    expect(reasonOf(startButton())).toBe("Voice calls not configured");
  });
});

describe("Demo_Hours_Text (Req 1.16)", () => {
  it("is shown for the Demo_Supplier", async () => {
    await mount({ isDemo: true });

    expect(container.textContent).toContain(DEMO_HOURS_TEXT);
    expect(DEMO_HOURS_TEXT).toBe(
      "Demo account: call hours not enforced. Real accounts: 10:00–19:00 IST, Monday to Saturday.",
    );
  });

  it("is absent for any other supplier", async () => {
    await mount({ isDemo: false });

    expect(container.textContent).not.toContain("Demo account");
  });
});

describe("hidden form fields (Req 1.9)", () => {
  it("posts `invoiceId` alone when there is no Demo_Override", async () => {
    mocks.startCall.mockResolvedValue({ invoiceId: INVOICE_ID, text: "x", role: "alert" });
    await mount();

    const names = Array.from(container.querySelectorAll("input")).map((i) => i.getAttribute("name"));
    expect(names).toEqual(["invoiceId"]);

    await submit();
    const form = mocks.startCall.mock.calls[0]![1] as FormData;
    expect(Array.from(form.entries())).toEqual([["invoiceId", INVOICE_ID]]);
  });

  it("posts `today` as well when there is a Demo_Override", async () => {
    mocks.startCall.mockResolvedValue({ invoiceId: INVOICE_ID, text: "x", role: "alert" });
    await mount({ isDemo: true, override: "2026-11-12" });

    await submit();
    const form = mocks.startCall.mock.calls[0]![1] as FormData;
    expect(Array.from(form.entries())).toEqual([
      ["invoiceId", INVOICE_ID],
      ["today", "2026-11-12"],
    ]);
  });
});

describe("after a start (Req 1.1, 1.15)", () => {
  it("shows the call URL, both links and the one-time text, with role=status", async () => {
    mocks.startCall.mockResolvedValue({
      invoiceId: INVOICE_ID,
      text: CALL_LINK_READY_TEXT,
      role: "status",
      callUrl: CALL_URL,
      waMeUrl: WA_ME_URL,
    });
    await mount();

    await submit();

    expect(mocks.startCall).toHaveBeenCalledTimes(1);
    const results = container.querySelectorAll("[role]");
    expect(results).toHaveLength(1);
    expect(results[0]!.getAttribute("role")).toBe("status");
    expect(results[0]!.textContent).toBe(CALL_LINK_READY_TEXT);
    expect(results[0]!.textContent).toContain("Link works once, for 10 minutes");
    expect(container.textContent).toContain(CALL_URL);

    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual(["Open call here", "Send call link in WhatsApp"]);
    const [open, wa] = links;
    expect(open!.getAttribute("href")).toBe(CALL_URL);
    expect(open!.getAttribute("target")).toBe("_blank");
    expect(open!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(wa!.getAttribute("href")).toBe(WA_ME_URL);
    expect(wa!.getAttribute("target")).toBe("_blank");
    expect(wa!.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("a refusal shows exactly one message with role=alert and no links", async () => {
    mocks.startCall.mockResolvedValue({ invoiceId: INVOICE_ID, text: "This buyer was already called today", role: "alert" });
    await mount();

    await submit();

    const results = container.querySelectorAll("[role]");
    expect(results).toHaveLength(1);
    expect(results[0]!.getAttribute("role")).toBe("alert");
    expect(results[0]!.textContent).toBe("This buyer was already called today");
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows the generic failure text with role=alert when the action rejects", async () => {
    mocks.startCall.mockRejectedValue(new Error("network down"));
    await mount();

    await submit();

    const results = container.querySelectorAll("[role]");
    expect(results).toHaveLength(1);
    expect(results[0]!.getAttribute("role")).toBe("alert");
    expect(results[0]!.textContent).toBe("Something went wrong. Try again.");
    expect(container.querySelector("a")).toBeNull();
    expect(startButton().disabled).toBe(false);
  });
});

describe("buildStartCallControls (Req 1.2, 10.1)", () => {
  const SECRET = "sk-test-secret-value-123";
  const DUE = "2026-10-17";
  const TODAY = "2026-11-12";

  function build(env: Record<string, string | undefined>, supplierUdyam = "UDYAM-XX-00-0000000") {
    return buildStartCallControls({
      tombstone: { id: INVOICE_ID, state: "overdue", dueDate: DUE },
      supplier: { udyamNumber: supplierUdyam },
      today: TODAY,
      override: null,
      env,
    });
  }

  it("is configured only when OPENAI_API_KEY is set and not empty", () => {
    expect(build({}).configured).toBe(false);
    expect(build({ OPENAI_API_KEY: undefined }).configured).toBe(false);
    expect(build({ OPENAI_API_KEY: "" }).configured).toBe(false);
    expect(build({ OPENAI_API_KEY: SECRET }).configured).toBe(true);
  });

  it("returns only booleans, the invoice id and the override: the key never appears", () => {
    const result = build({ OPENAI_API_KEY: SECRET });

    expect(Object.keys(result).sort()).toEqual(["callable", "configured", "invoiceId", "isDemo", "override"]);
    expect(result).toEqual({
      invoiceId: INVOICE_ID,
      callable: true,
      configured: true,
      isDemo: false,
      override: null,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("passes the Demo_Override through and flags the Demo_Supplier", () => {
    const result = buildStartCallControls({
      tombstone: { id: INVOICE_ID, state: "overdue", dueDate: DUE },
      supplier: { udyamNumber: DEMO_SUPPLIER.udyamNumber },
      today: TODAY,
      override: TODAY,
      env: { OPENAI_API_KEY: SECRET },
    });

    expect(result.isDemo).toBe(true);
    expect(result.override).toBe(TODAY);
  });

  it("is not callable for a paid or uncovered invoice, or one not yet due on Today", () => {
    const base = { supplier: { udyamNumber: "UDYAM-XX-00-0000000" }, today: TODAY, override: null, env: {} };
    const callable = (state: "resurrected" | "not_covered" | "overdue", dueDate: string | null) =>
      buildStartCallControls({ ...base, tombstone: { id: INVOICE_ID, state, dueDate } }).callable;

    expect(callable("overdue", DUE)).toBe(true);
    expect(callable("resurrected", DUE)).toBe(false);
    expect(callable("not_covered", DUE)).toBe(false);
    expect(callable("overdue", null)).toBe(false);
    expect(callable("overdue", TODAY)).toBe(false);
  });
});

describe("copy constants (Req 11.7)", () => {
  it("the Disclaimer in call-copy equals the agent package's DISCLAIMER", () => {
    expect(CALL_DISCLAIMER).toBe(DISCLAIMER);
  });

  it("the Call_Copy is the fixed wording", () => {
    expect(CALL_COPY).toBe(CALL_COPY_TEXT);
  });
});
