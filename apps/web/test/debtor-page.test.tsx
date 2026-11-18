import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  SupplierNotFoundError,
  toEngineInvoice,
  type Db,
  type DebtorData,
  type DraftRow,
  type DraftWithContext,
  type GraveyardInvoiceRecord,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import { formatINR, type BankRate, type EscalationDecision } from "@dues-banshee/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signOut: vi.fn(),
  redirect: vi.fn((url: string) => {
    // Next's redirect() never returns: it throws to navigate.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: vi.fn(() => {
    // Next's notFound() never returns either.
    throw new Error("NEXT_NOT_FOUND");
  }),
  pathname: "/debtors/x",
  query: "",
  revalidatePath: vi.fn(),
  getDb: vi.fn(),
  close: vi.fn(),
  getSupplier: vi.fn(),
  getBankRate: vi.fn(),
  getDebtorData: vi.fn(),
  listPendingDrafts: vi.fn(),
  getDraftForSupplier: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signOut: mocks.signOut }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.query),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@dues-banshee/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dues-banshee/db")>()),
  getSupplier: mocks.getSupplier,
  getBankRate: mocks.getBankRate,
  getDebtorData: mocks.getDebtorData,
  listPendingDrafts: mocks.listPendingDrafts,
  getDraftForSupplier: mocks.getDraftForSupplier,
}));
// The DraftCard's server actions import the agent; no model is ever called from these tests.
vi.mock("@dues-banshee/agent", () => ({
  approveDraft: vi.fn(),
  editDraft: vi.fn(),
  rejectDraft: vi.fn(),
  redraft: vi.fn(),
  runLadder: vi.fn(),
  productionModels: vi.fn(),
}));

import DebtorPage from "@/app/(debtor)/debtors/[id]/page";
import DebtorError from "@/app/(debtor)/error";
import { AppShell } from "@/components/app-shell";
import type { NoticeParams } from "@/lib/approvals/notices";

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SUPPLIER_ID = "00000000-0000-4000-8000-0000000000ff";
const BUYER_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_BUYER_ID = "99999999-9999-4999-8999-999999999999";
const OTHER_BUYER_ID = "33333333-3333-4333-8333-333333333333";
const SHARMA_INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const PAID_INVOICE_ID = "44444444-4444-4444-8444-444444444444";
const DRAFT_ID = "00000000-0000-4000-8000-0000000000d1";
const DRAFT_ID_2 = "00000000-0000-4000-8000-0000000000d2";
const OTHER_DRAFT_ID = "00000000-0000-4000-8000-0000000000d3";

const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};
// Same supplier row shape, but not the demo supplier: the `today` override must not apply.
const NON_DEMO: Supplier = { ...SUPPLIER, id: OTHER_SUPPLIER_ID, udyamNumber: "UDYAM-XX-00-0000000" };
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const DB = {} as Db;

const FOOTER = "Reminders a supplier sends to its own buyers. Not legal advice.";
const LOAD_FAILED = "We couldn&#x27;t load this buyer just now. Please try again.";
const SHARMA_PRINCIPAL = formatINR(41200000, "full");

// 2026-11-12 11:30 IST, so Today is 2026-11-12 whenever a test gives no valid demo override.
const NOW = Date.parse("2026-11-12T06:00:00Z");

const ADVANCE_NUDGE: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};

function recordFor(
  invoiceNumber: string,
  invoiceId: string,
  buyerId: string,
  buyerName: string,
): GraveyardInvoiceRecord {
  const demo = DEMO_INVOICES.find((d) => d.invoiceNumber === invoiceNumber);
  if (demo === undefined) throw new Error(`no demo invoice ${invoiceNumber}`);
  const row: InvoiceRow = {
    id: invoiceId,
    supplierId: SUPPLIER_ID,
    buyerId,
    invoiceNumber: demo.invoiceNumber,
    invoiceNumberKey: demo.invoiceNumber.toLowerCase(),
    invoiceDate: demo.acceptedOn,
    acceptedOn: demo.acceptedOn,
    acceptanceDateDefaulted: false,
    agreedTermDays: demo.agreedTermDays ?? null,
    amountPaise: demo.amountPaise,
    paidOn: demo.paidOn ?? null,
    supplierCategory: SUPPLIER_ROW.supplierCategory,
    supplierActivity: SUPPLIER_ROW.supplierActivity,
    createdAt: new Date(0),
  };
  return {
    invoice: toEngineInvoice(row, SUPPLIER_ROW),
    buyerName,
    invoiceNumber: demo.invoiceNumber,
    history: [],
    buyerId,
    invoiceDate: row.invoiceDate,
  };
}

const sharmaRecord = () => recordFor("LPC/26-27/0412", SHARMA_INVOICE_ID, BUYER_ID, "Sharma Traders");
// The demo seed's paid invoice, filed under Sharma Traders for this fixture: a resurrected panel.
const paidRecord = () => recordFor("LPC/26-27/0377", PAID_INVOICE_ID, BUYER_ID, "Sharma Traders");

function debtorData(records: GraveyardInvoiceRecord[], withEvents = false): DebtorData {
  return {
    buyer: { id: BUYER_ID, name: "Sharma Traders" },
    records,
    events: withEvents
      ? [
          {
            id: "ev-1",
            invoiceId: SHARMA_INVOICE_ID,
            step: "whatsapp_nudge",
            action: "approved",
            occurredOn: "2026-11-10",
          },
        ]
      : [],
    promises: [],
  };
}

function draftFor(id: string, record: GraveyardInvoiceRecord): DraftWithContext {
  const draft: DraftRow = {
    id,
    invoiceId: record.invoice.id,
    step: "whatsapp_nudge",
    status: "pending",
    language: "hinglish",
    bodyText: "Sharma ji, a gentle reminder about LPC/26-27/0412",
    finalText: "Sharma ji, a gentle reminder about LPC/26-27/0412\n\nBasis: MSMED-15\nNot legal advice.",
    ruleIds: ["MSMED-15"],
    modelId: "mock-haiku",
    decision: ADVANCE_NUDGE,
    document: null,
    createdOn: "2026-11-12",
    decidedAt: null,
    sendClaimedAt: null,
    createdAt: new Date(1000),
  };
  return {
    draft,
    invoice: record.invoice,
    invoiceDate: record.invoiceDate,
    acceptanceDateDefaulted: false,
    buyerId: record.buyerId,
    buyerName: record.buyerName,
    invoiceNumber: record.invoiceNumber,
  };
}

type SearchParams = NoticeParams & { today?: string | string[] };

async function renderElement(id: string, searchParams: SearchParams) {
  return DebtorPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) });
}

async function render(id: string = BUYER_ID, searchParams: SearchParams = {}): Promise<string> {
  return renderToStaticMarkup(await renderElement(id, searchParams));
}

/** The message of the error a render rejects with. */
async function failure(id: string, searchParams: SearchParams = {}): Promise<string> {
  try {
    await render(id, searchParams);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the page rendered instead of throwing");
}

/** Visible text: tags removed, the entities React escapes in these strings turned back. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/** The markup of the Invoice_Panel `<section>` with this invoice id. */
function panelHtml(html: string, invoiceId: string): string {
  const start = html.indexOf(`<section id="invoice-${invoiceId}"`);
  if (start === -1) throw new Error(`no panel for ${invoiceId}`);
  return html.slice(start, html.indexOf("</section>", start) + "</section>".length);
}

/** The `href` of the "Try again" link. */
function retryHref(html: string): string | null {
  return /<a [^>]*href="([^"]*)"[^>]*>Try again<\/a>/.exec(html)?.[1] ?? null;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ supplierId: SUPPLIER_ID });
  mocks.signOut.mockReset();
  mocks.redirect.mockClear();
  mocks.notFound.mockClear();
  mocks.pathname = "/debtors/x";
  mocks.query = "";
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.getDb.mockReset().mockReturnValue({ db: DB, close: mocks.close });
  mocks.getSupplier.mockReset().mockResolvedValue(SUPPLIER);
  mocks.getBankRate.mockReset().mockResolvedValue(BANK_RATE);
  mocks.getDebtorData.mockReset().mockResolvedValue(debtorData([sharmaRecord()]));
  mocks.listPendingDrafts.mockReset().mockResolvedValue([]);
  mocks.getDraftForSupplier.mockReset().mockResolvedValue(null);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  errorSpy.mockRestore();
  nowSpy.mockRestore();
});

describe("DebtorPage session (Req 1.1, 1.2, 1.4)", () => {
  it("redirects to /signin when signed out, before reading any data", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(render()).rejects.toThrow("NEXT_REDIRECT /signin");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("redirects to /signin when the session has no supplierId", async () => {
    mocks.auth.mockResolvedValue({});

    await expect(render()).rejects.toThrow("NEXT_REDIRECT /signin");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([BUYER_ID, "not-a-uuid", UNKNOWN_BUYER_ID])(
    "redirects once to /signin?error=SessionExpired and renders no markup for a stale session (id %j)",
    async (id) => {
      mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));

      await expect(render(id)).rejects.toThrow("NEXT_REDIRECT /signin?error=SessionExpired");
      expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin?error=SessionExpired");
      expect(mocks.notFound).not.toHaveBeenCalled();
      expect(mocks.getDebtorData).not.toHaveBeenCalled();
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it("ignores a supplier id in the query and reads only the session's supplier", async () => {
    const html = await render(BUYER_ID, {
      supplierId: OTHER_SUPPLIER_ID,
      supplier: OTHER_SUPPLIER_ID,
    } as SearchParams);

    expect(html).toContain("Sharma Traders");
    expect(mocks.getSupplier).toHaveBeenCalledExactlyOnceWith(DB, SUPPLIER_ID);
    expect(mocks.getDebtorData).toHaveBeenCalledExactlyOnceWith(DB, SUPPLIER_ID, BUYER_ID);
    expect(mocks.listPendingDrafts).toHaveBeenCalledExactlyOnceWith(DB, SUPPLIER_ID);
    expect(JSON.stringify(mocks.getDebtorData.mock.calls)).not.toContain(OTHER_SUPPLIER_ID);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("DebtorPage not found (Req 1.3)", () => {
  it("calls notFound for a non-uuid id and queries no buyer", async () => {
    const message = await failure("not-a-uuid");

    expect(message).toBe("NEXT_NOT_FOUND");
    expect(message).not.toContain("Sharma Traders");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getDebtorData).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("calls notFound for an unknown uuid", async () => {
    mocks.getDebtorData.mockResolvedValue(null);

    const message = await failure(UNKNOWN_BUYER_ID);

    expect(message).toBe("NEXT_NOT_FOUND");
    expect(message).not.toContain("Sharma Traders");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
    expect(mocks.getDebtorData).toHaveBeenCalledExactlyOnceWith(DB, SUPPLIER_ID, UNKNOWN_BUYER_ID);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("calls notFound for another supplier's buyer, with the same outcome as an unknown id", async () => {
    // BUYER_ID belongs to the demo supplier. The session is another supplier, so the scoped read finds nothing.
    mocks.auth.mockResolvedValue({ supplierId: OTHER_SUPPLIER_ID });
    mocks.getSupplier.mockResolvedValue(NON_DEMO);
    mocks.getDebtorData.mockImplementation(async (_db: Db, supplierId: string, buyerId: string) =>
      supplierId === SUPPLIER_ID && buyerId === BUYER_ID ? debtorData([sharmaRecord()]) : null,
    );

    const foreign = await failure(BUYER_ID);
    const unknown = await failure(UNKNOWN_BUYER_ID);

    expect(foreign).toBe("NEXT_NOT_FOUND");
    expect(foreign).toBe(unknown);
    expect(foreign).not.toContain("Sharma Traders");
    expect(mocks.notFound).toHaveBeenCalledTimes(2);
    expect(mocks.getDebtorData.mock.calls).toEqual([
      [DB, OTHER_SUPPLIER_ID, BUYER_ID],
      [DB, OTHER_SUPPLIER_ID, UNKNOWN_BUYER_ID],
    ]);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("DebtorPage load failure (Req 1.6)", () => {
  const SQL = "select * from buyers where supplier_id = $1 failed: password authentication failed";

  function breakRead(): Error {
    const boom = new Error(SQL);
    boom.stack = "Error: select * from buyers\n    at secretFunction (/srv/app/internal/secret-file.ts:12:3)";
    mocks.getDebtorData.mockRejectedValue(boom);
    return boom;
  }

  function expectNoLeak(html: string, boom: Error): void {
    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain(boom.message);
    expect(html).not.toContain("password authentication failed");
    expect(html).not.toContain("secretFunction");
    expect(html).not.toContain("secret-file.ts");
    expect(html).not.toMatch(/select/i);
    expect(html).not.toContain("Sharma Traders");
  }

  it("shows the fixed error text and a retry link to the same URL, with no error text", async () => {
    const boom = breakRead();

    const html = await render();

    expectNoLeak(html, boom);
    expect(retryHref(html)).toBe(`/debtors/${BUYER_ID}`);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("keeps the demo override in the retry link for the demo supplier", async () => {
    const boom = breakRead();

    const html = await render(BUYER_ID, { today: "2027-03-10" });

    expectNoLeak(html, boom);
    expect(retryHref(html)).toBe(`/debtors/${BUYER_ID}?today=2027-03-10`);
  });

  it("drops the today value from the retry link for another supplier", async () => {
    mocks.getSupplier.mockResolvedValue(NON_DEMO);
    const boom = breakRead();

    const html = await render(BUYER_ID, { today: "2027-03-10" });

    expectNoLeak(html, boom);
    expect(retryHref(html)).toBe(`/debtors/${BUYER_ID}`);
  });

  it("shows the same error view when the database cannot be opened", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });

    const html = await render(BUYER_ID, { today: "2027-03-10" });

    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain("DATABASE_URL");
    expect(retryHref(html)).toBe(`/debtors/${BUYER_ID}`);
  });
});

describe("(debtor)/error.tsx backstop (Req 1.6)", () => {
  const MESSAGE = "connection refused: select * from invoices where supplier_id = 'abc'";
  const STACK = "Error: connection refused\n    at query (/srv/db.ts:12:3)\n    at load (/srv/load.ts:40:9)";
  const DIGEST = "digest-1234567890";

  function renderBoundary(): string {
    const error = Object.assign(new Error(MESSAGE), { digest: DIGEST, stack: STACK });
    // Next passes { error, reset }; the component takes no props and must not render them.
    const Boundary = DebtorError as unknown as (p: { error: Error; reset: () => void }) => React.ReactElement;
    return renderToStaticMarkup(<Boundary error={error} reset={() => undefined} />);
  }

  it("renders none of the message, stack or digest, and links retry to the same path", () => {
    mocks.pathname = `/debtors/${BUYER_ID}`;

    const html = renderBoundary();

    expect(html).toContain(LOAD_FAILED);
    expect(retryHref(html)).toBe(`/debtors/${BUYER_ID}`);
    for (const leaked of [MESSAGE, "connection refused", "select * from invoices", "supplier_id", STACK, "/srv/db.ts", DIGEST]) {
      expect(html).not.toContain(leaked);
    }
  });

  it("keeps the today value on the retry link and still renders no error data", () => {
    mocks.pathname = `/debtors/${BUYER_ID}`;
    mocks.query = "today=2027-03-10";

    const html = renderBoundary();

    expect(retryHref(html)).toBe(`/debtors/${BUYER_ID}?today=2027-03-10`);
    expect(html.replace(/<[^>]*>/g, "")).toBe(`${LOAD_FAILED}Try again`);
    for (const leaked of [MESSAGE, STACK, DIGEST]) expect(html).not.toContain(leaked);
  });
  it.each(["2027-02-30", "2028-01-01", "2023-12-31", "2027-3-10", "<script>", "", "2027-03-10&x=1"])(
    "drops an invalid today value (%j) from the retry link",
    (value) => {
      mocks.pathname = `/debtors/${BUYER_ID}`;
      mocks.query = `today=${encodeURIComponent(value)}`;
      const html = renderBoundary();
      expect(retryHref(html)).toBe(`/debtors/${BUYER_ID}`);
      expect(html).not.toContain("today");
    },
  );
});

describe("DebtorPage Today and the demo override (Req 2.2, 2.3)", () => {
  beforeEach(() => {
    mocks.listPendingDrafts.mockResolvedValue([draftFor(DRAFT_ID, sharmaRecord())]);
  });

  it("shows the Demo_Date_Chip and passes the override to every action form for the demo supplier", async () => {
    const html = await render(BUYER_ID, { today: "2027-03-10" });

    expect(visibleText(html)).toContain("Demo date: 10 Mar 2027");
    expect(mocks.getBankRate).toHaveBeenCalledWith(DB, "2027-03-10");
    // One hidden `today` input in each of the Draft's four forms (save, approve, redraft, reject).
    expect(count(html, 'name="today" value="2027-03-10"')).toBe(4);
    expect(count(html, 'name="today"')).toBe(4);
  });

  it("shows no chip and no today field without a valid override", async () => {
    for (const searchParams of [{}, { today: "2026-02-30" }]) {
      const html = await render(BUYER_ID, searchParams);

      expect(html).not.toContain("Demo date");
      expect(count(html, 'name="today"')).toBe(0);
    }
    expect(mocks.getBankRate).toHaveBeenLastCalledWith(DB, "2026-11-12");
  });

  it("gives another supplier the real IST date, no chip and no today field, whatever ?today= says", async () => {
    mocks.getSupplier.mockResolvedValue(NON_DEMO);
    // 2026-11-12 20:00 UTC is 2026-11-13 01:30 IST.
    nowSpy.mockReturnValue(Date.parse("2026-11-12T20:00:00Z"));

    const html = await render(BUYER_ID, { today: "2027-03-10" });

    expect(html).not.toContain("Demo date");
    expect(html).not.toContain("2027-03-10");
    expect(count(html, 'name="today"')).toBe(0);
    expect(mocks.getBankRate).toHaveBeenCalledWith(DB, "2026-11-13");
  });
});

describe("DebtorPage notices (Req 7.6)", () => {
  it("shows a success notice with role=status", async () => {
    const html = await render(BUYER_ID, { notice: "approved" });

    expect(html).toMatch(/<p role="status"[^>]*>Draft approved\. Nothing is sent yet\.<\/p>/);
    expect(html).not.toContain('role="alert"');
  });

  it("shows an error notice with role=alert", async () => {
    const html = await render(BUYER_ID, { notice: "empty_body" });

    expect(html).toMatch(/<p role="alert"[^>]*>The message can&#x27;t be empty<\/p>/);
    expect(html).not.toContain('role="status"');
  });

  it("shows the expired text with its label, and no notice for an unknown code", async () => {
    const expired = await render(BUYER_ID, { notice: "expired", label: "step:legal_notice" });
    expect(visibleText(expired)).toContain("This draft is out of date: Legal notice");
    expect(expired).toContain('role="alert"');

    const unknown = await render(BUYER_ID, { notice: "<script>alert(1)</script>" });
    expect(unknown).not.toContain("<script>");
    expect(unknown).not.toContain('role="status"');
    expect(unknown).not.toContain('role="alert"');
  });

  it("shows no notice without a notice param", async () => {
    const html = await render();

    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });
});

describe("DebtorPage empty states (Req 4.7, 7.2)", () => {
  it("shows the no-invoices text and a link to / when the buyer has no Debtor_Invoice", async () => {
    mocks.getDebtorData.mockResolvedValue(debtorData([]));

    const html = await render();

    expect(html).toContain("<h1");
    expect(html).toContain("Sharma Traders");
    expect(visibleText(html)).toContain("No invoices for this buyer on this date");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Back to the graveyard<\/a>/);
    expect(count(html, "<section id=\"invoice-")).toBe(0);
    expect(html).not.toContain("Send pay link");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("shows 'No drafts waiting for this buyer' under the heading and renders no DraftCard", async () => {
    const html = await render();
    const text = visibleText(html);

    expect(text).toContain("Waiting for your approval No drafts waiting for this buyer");
    expect(count(html, "<article")).toBe(0);
    expect(visibleText(html)).not.toContain("No invoices for this buyer on this date");
  });
});

describe("DebtorPage Invoice_Panels and placeholders (Req 8.1, 8.2, 4.4)", () => {
  it("shows the exact Sharma Traders figures for Today 2026-11-12", async () => {
    const html = await render();
    const panel = visibleText(panelHtml(html, SHARMA_INVOICE_ID));

    expect(html).toMatch(/<h1[^>]*>Sharma Traders<\/h1>/);
    expect(panel).toContain("LPC/26-27/0412");
    expect(panel).toContain(SHARMA_PRINCIPAL);
    expect(panel).toContain("Due 17 Oct 2026 · MSMED-15");
    expect(panel).toContain("Overdue 26 days, interest accruing");
    expect(panel).toContain(`Interest ${formatINR(512794, "full")} · MSMED-16`);
    expect(panel).toContain("Tax bomb armed: 139 days left to 31 March");
    expect(panel).toContain("IT-43BH");
    expect(panel).toContain("Next: WhatsApp nudge");
  });

  it("renders the placeholders disabled, each described by its 'Arrives with …' text", async () => {
    const panel = panelHtml(await render(), SHARMA_INVOICE_ID);

    const pay = /<button [^>]*>Send pay link<\/button>/.exec(panel)?.[0];
    const call = /<button [^>]*>Start call<\/button>/.exec(panel)?.[0];
    expect(pay).toBeDefined();
    expect(call).toBeDefined();
    for (const button of [pay!, call!]) {
      expect(button).toContain('type="button"');
      expect(button).toMatch(/\sdisabled(=""|\s|>)/);
    }

    const payTarget = /aria-describedby="([^"]+)"/.exec(pay!)?.[1];
    const callTarget = /aria-describedby="([^"]+)"/.exec(call!)?.[1];
    expect(payTarget).toBe(`pay-link-note-${SHARMA_INVOICE_ID}`);
    expect(callTarget).toBe(`start-call-note-${SHARMA_INVOICE_ID}`);
    expect(panel).toMatch(new RegExp(`<span [^>]*id="${payTarget}"[^>]*>Arrives with WhatsApp</span>`));
    expect(panel).toMatch(new RegExp(`<span [^>]*id="${callTarget}"[^>]*>Arrives with voice call</span>`));
    // No form, handler or link: the buttons do nothing in this spec.
    expect(panel).not.toContain("<form");
    expect(panel).not.toContain("onclick");
  });

  it("shows the placeholders on the unpaid panel only, not on a resurrected one", async () => {
    mocks.getDebtorData.mockResolvedValue(debtorData([sharmaRecord(), paidRecord()]));

    const html = await render();
    const unpaid = panelHtml(html, SHARMA_INVOICE_ID);
    const paid = panelHtml(html, PAID_INVOICE_ID);

    expect(count(html, "Send pay link")).toBe(1);
    expect(count(html, "Start call")).toBe(1);
    expect(unpaid).toContain("Send pay link");
    expect(paid).toContain('data-state="resurrected"');
    for (const absent of ["Send pay link", "Start call", "Arrives with WhatsApp", "Arrives with voice call", "<button", "aria-describedby"]) {
      expect(paid).not.toContain(absent);
    }
  });
});

describe("DebtorPage Drafts (Req 7.1, 7.5)", () => {
  it("sends returnTo=/debtors/<buyerId> with every form of every Draft, and lists only this buyer's Drafts", async () => {
    mocks.listPendingDrafts.mockResolvedValue([
      draftFor(DRAFT_ID, sharmaRecord()),
      draftFor(
        OTHER_DRAFT_ID,
        recordFor(
          DEMO_INVOICES[1]!.invoiceNumber,
          "55555555-5555-4555-8555-555555555555",
          OTHER_BUYER_ID,
          "Gupta Engineering Works",
        ),
      ),
      draftFor(DRAFT_ID_2, sharmaRecord()),
    ]);

    const html = await render();

    expect(count(html, "<article")).toBe(2);
    expect(html).toContain(`id="draft-${DRAFT_ID}"`);
    expect(html).toContain(`id="draft-${DRAFT_ID_2}"`);
    expect(html).not.toContain(OTHER_DRAFT_ID);
    expect(html).not.toContain("Gupta Engineering Works");
    // Four forms per card: save edit, approve, redraft, reject.
    expect(count(html, "<form")).toBe(8);
    expect(count(html, 'name="returnTo"')).toBe(8);
    expect(count(html, `name="returnTo" value="/debtors/${BUYER_ID}"`)).toBe(8);
    expect(visibleText(html)).not.toContain("No drafts waiting for this buyer");
    expect(visibleText(html)).toContain("Waiting for your approval");
  });
});

describe("DebtorPage Candle_Timeline (Req 5.7)", () => {
  it("is an <ol> whose entries carry their text, date and invoice number, with aria-hidden candles", async () => {
    mocks.getDebtorData.mockResolvedValue(debtorData([sharmaRecord()], true));

    const html = await render();
    const start = html.indexOf("<ol");
    const list = html.slice(start, html.indexOf("</ol>") + "</ol>".length);

    expect(start).toBeGreaterThan(-1);
    expect(count(list, "<li")).toBe(3);
    expect(count(list, 'aria-hidden="true"')).toBe(3);
    expect(list.match(/<span [^>]*aria-hidden="true"[^>]*><\/span>/g)).toHaveLength(3);

    const text = visibleText(list);
    const invoiceAt = text.indexOf(`2 Sep 2026 Invoice LPC/26-27/0412 raised for ${SHARMA_PRINCIPAL} LPC/26-27/0412`);
    const dueAt = text.indexOf("17 Oct 2026 Due date (MSMED-15) LPC/26-27/0412");
    const ladderAt = text.indexOf("10 Nov 2026 WhatsApp nudge approved LPC/26-27/0412");
    expect(invoiceAt).toBeGreaterThan(-1);
    expect(dueAt).toBeGreaterThan(invoiceAt);
    expect(ladderAt).toBeGreaterThan(dueAt);
    // The candle graphics hold no text, so the entries read the same without them.
    expect(text.replace(/\s+/g, " ").trim()).toBe(
      `2 Sep 2026 Invoice LPC/26-27/0412 raised for ${SHARMA_PRINCIPAL} LPC/26-27/0412 ` +
        "17 Oct 2026 Due date (MSMED-15) LPC/26-27/0412 " +
        "10 Nov 2026 WhatsApp nudge approved LPC/26-27/0412",
    );
  });
});

describe("DebtorPage footer through the App_Shell (Req 4.8)", () => {
  it("shows the disclaimer line when the page is rendered inside the shell", async () => {
    const element = await AppShell({ children: await renderElement(BUYER_ID, {}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain(FOOTER);
    expect(html).toContain("Sharma Traders");
  });
});
