// The buyer's Call_Page on a real in-memory Postgres (PGlite) with the Demo_Seed. Only the database
// handle (`getDb`) is replaced; the token lookup is the real query.
// Requirements: 2.1, 2.2, 2.3, 4.2, 4.3, 10.2
import { DISCLAIMER } from "@dues-banshee/agent";
import {
  DEMO_SUPPLIER,
  claimJoin,
  createVoiceCall,
  findSupplierIdByUdyam,
  invoices,
  seed,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { formatINR } from "@dues-banshee/engine";
import { generateJoinToken, hashToken } from "@dues-banshee/voice";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  close: vi.fn(async () => {}),
  // `null` = use the real useState; otherwise the CallClient starts in this state.
  forcedView: null as { phase: string; countdown?: string } | null,
}));

vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
// CallClient keeps its phase in useState, and static rendering only shows the first state. Forcing the
// state lets one render show the "mic denied" screen without jsdom. Every other hook is the real one.
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    useState: ((...args: [unknown?]) =>
      mocks.forcedView !== null && args[0] === null
        ? [mocks.forcedView, () => {}]
        : (real.useState as (...a: unknown[]) => unknown)(...args)) as unknown as typeof real.useState,
  };
});

import CallPage from "@/app/(call)/call/[token]/page";
import { CallClient } from "@/app/(call)/call/[token]/call-client";

const SHARMA = "LPC/26-27/0412";
const SUPPLIER_NAME = "Laxmi Precision Components (Demo)";
const CALL_COPY = "AI call over the internet. Phone (PSTN) calls are on the roadmap.";
const RECORDING_LINE = "You will talk to an AI assistant. The call is recorded and transcribed.";
const EXPIRED_TEXT = "This call link has expired or was already used";

let template: TestDb;
const open: TestDb[] = [];
let t: TestDb;
let supplierId: string;
let sharmaInvoiceId: string;

beforeAll(async () => {
  template = await createTestDb();
  await seed(template.db);
});
afterAll(async () => {
  await template.close();
});
beforeEach(async () => {
  t = await cloneTestDb(template);
  open.push(t);
  const id = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  const rows = await t.db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber }).from(invoices);
  const sharma = rows.find((r) => r.invoiceNumber === SHARMA);
  if (id === null || sharma === undefined) throw new Error("test setup: demo seed missing");
  supplierId = id;
  sharmaInvoiceId = sharma.id;
  mocks.getDb.mockReturnValue({ db: t.db, close: mocks.close });
  mocks.forcedView = null;
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((x) => x.close()));
});

/** A Voice_Call for Sharma Traders created at `now`; returns the plain token and its stored row. */
async function startCall(now: Date): Promise<{ token: string; tokenExpiresAt: Date }> {
  const token = generateJoinToken();
  const created = await createVoiceCall(t.db, {
    supplierId,
    invoiceId: sharmaInvoiceId,
    callToday: "2026-11-12",
    tokenHash: hashToken(token),
    now,
  });
  if (created === null) throw new Error("test setup: createVoiceCall returned null");
  return { token, tokenExpiresAt: created.tokenExpiresAt };
}

async function render(token: string): Promise<string> {
  const element = await CallPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(element);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Call_Page with a valid token", () => {
  it("shows the supplier name, Call_Copy, Disclaimer, the AI and recording line and one Join call button", async () => {
    const { token } = await startCall(new Date());
    const html = await render(token);

    expect(html).toContain(SUPPLIER_NAME);
    expect(html).toContain(CALL_COPY);
    expect(html).toContain(DISCLAIMER);
    expect(html).toContain(RECORDING_LINE);
    expect(count(html, "Join call")).toBe(1);
    expect(count(html, "<button")).toBe(1);
    expect(html).toMatch(/<button[^>]*>Join call<\/button>/);
    expect(html).not.toContain(EXPIRED_TEXT);
    expect(mocks.close).toHaveBeenCalled();
  });

  it("shows no invoice figure, invoice number or buyer name before the call starts", async () => {
    const { token } = await startCall(new Date());
    const html = await render(token);

    for (const forbidden of [
      "Sharma",
      SHARMA,
      "LPC/26",
      formatINR(41200000, "full"),
      formatINR(512794, "full"),
      formatINR(41712794, "full"),
      "412000",
      "512794",
      "41712794",
      "Total due",
      "overdue",
    ]) {
      expect(html, forbidden).not.toContain(forbidden);
    }
    // Other demo buyers stay out of it too.
    expect(html).not.toContain("Kumar");
  });

  it("does not put the Join_Token or its hash in the markup", async () => {
    const { token } = await startCall(new Date());
    const html = await render(token);
    expect(html).not.toContain(token);
    expect(html).not.toContain(hashToken(token));
  });

  it("renders the remote audio element with playsinline and autoplay", async () => {
    const { token } = await startCall(new Date());
    const html = await render(token);
    const audio = /<audio[^>]*>/.exec(html)?.[0] ?? "";
    expect(audio.toLowerCase()).toContain("playsinline");
    expect(audio.toLowerCase()).toContain("autoplay");
  });

  it("is still valid one millisecond before token_expires_at", async () => {
    const { token, tokenExpiresAt } = await startCall(new Date("2026-11-12T05:00:00.000Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(tokenExpiresAt.getTime() - 1));
    expect(await render(token)).toContain(SUPPLIER_NAME);
  });

  it("does not need a sign-in: rendering never reads a session", async () => {
    // The page imports no auth module; the test mocks none and still renders.
    const { token } = await startCall(new Date());
    await expect(render(token)).resolves.toContain("Join call");
  });
});

describe("Call_Page with a token that cannot join", () => {
  async function expiredMarkups() {
    const used = await startCall(new Date());
    expect(await claimJoin(t.db, hashToken(used.token), new Date())).not.toBeNull();
    const replacedByNewer = await startCall(new Date());
    // A newer link for the same buyer expires the older `created` one.
    await startCall(new Date());
    const ended = await startCall(new Date());
    await claimJoin(t.db, hashToken(ended.token), new Date());
    await t.pglite.query(
      `UPDATE voice_calls SET status = 'ended', ended_at = now(), duration_seconds = 0, outcome = 'incomplete' WHERE token_hash = $1`,
      [hashToken(ended.token)],
    );

    const boundary = await startCall(new Date("2026-11-12T05:00:00.000Z"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(boundary.tokenExpiresAt);
    const atExpiry = await render(boundary.token);
    vi.setSystemTime(new Date(boundary.tokenExpiresAt.getTime() + 1));
    const afterExpiry = await render(boundary.token);
    vi.useRealTimers();

    return {
      markups: {
        used: await render(used.token),
        atExpiry,
        afterExpiry,
        replaced: await render(replacedByNewer.token),
        ended: await render(ended.token),
        unknown: await render(generateJoinToken()),
        empty: await render(""),
      },
    };
  }

  it("renders the expired text for used, expired, replaced, ended and unknown tokens", async () => {
    const { markups } = await expiredMarkups();
    for (const [label, html] of Object.entries(markups)) {
      expect(html, label).toContain(EXPIRED_TEXT);
      expect(count(html, "Join call"), label).toBe(0);
      expect(count(html, "<button"), label).toBe(0);
    }
  });

  it("renders identical markup for every one of those cases", async () => {
    const { markups } = await expiredMarkups();
    const [first, ...rest] = Object.values(markups);
    for (const html of rest) expect(html).toBe(first);
  });

  it("shows no supplier, buyer or invoice data and no token", async () => {
    const { markups } = await expiredMarkups();
    for (const [label, html] of Object.entries(markups)) {
      for (const forbidden of [SUPPLIER_NAME, "Laxmi", "Sharma", "Kumar", SHARMA, "₹", RECORDING_LINE, CALL_COPY]) {
        expect(html, `${label}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("CallClient microphone denial screen", () => {
  it("starts with one enabled Join call button and no alert", () => {
    const html = renderToStaticMarkup(<CallClient token="t" />);
    expect(count(html, "<button")).toBe(1);
    expect(html).toMatch(/<button[^>]*>Join call<\/button>/);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain('role="alert"');
  });

  it("after a denial keeps Join call enabled and shows the alert text", () => {
    mocks.forcedView = { phase: "mic_error" };
    const html = renderToStaticMarkup(<CallClient token="t" />);
    expect(html).toMatch(/<button[^>]*>Join call<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/<p[^>]*role="alert"[^>]*>Microphone access is needed for the call<\/p>/);
  });

  it("shows the could-not-start alert and keeps Join call for a start error", () => {
    mocks.forcedView = { phase: "start_error" };
    const html = renderToStaticMarkup(<CallClient token="t" />);
    expect(html).toMatch(/<button[^>]*>Join call<\/button>/);
    expect(html).toMatch(/role="alert"[^>]*>The call could not start\. Please try again later\.<\/p>/);
  });

  it("shows the expired alert without a Join call button when the join returns 404", () => {
    mocks.forcedView = { phase: "expired" };
    const html = renderToStaticMarkup(<CallClient token="t" />);
    expect(html).not.toContain("Join call");
    expect(html).toMatch(/role="alert"[^>]*>This call link has expired or was already used<\/p>/);
  });

  it("shows the countdown and a Hang up button while live", () => {
    mocks.forcedView = { phase: "live", countdown: "4:59" };
    const html = renderToStaticMarkup(<CallClient token="t" />);
    expect(html).toContain("4:59");
    expect(html).toMatch(/<button[^>]*>Hang up<\/button>/);
    expect(html).not.toContain("Join call");
  });

  it("shows The call has ended in place of the countdown and Hang up", () => {
    mocks.forcedView = { phase: "ended" };
    const html = renderToStaticMarkup(<CallClient token="t" />);
    expect(html).toContain("The call has ended");
    expect(html).not.toContain("Hang up");
    expect(html).not.toContain('role="timer"');
  });
});
