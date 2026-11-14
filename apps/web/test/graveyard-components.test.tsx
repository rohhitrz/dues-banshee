import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { GraveyardEmpty } from "@/components/graveyard/graveyard-empty";
import { LoadError } from "@/components/graveyard/load-error";
import { GraveyardPendingProvider } from "@/components/graveyard/pending-context";
import { TimeTravel } from "@/components/graveyard/time-travel";
import { Tombstone } from "@/components/graveyard/tombstone";
import { TotalsBar } from "@/components/graveyard/totals-bar";
import type { TombstoneView } from "@/lib/graveyard/build-graveyard";

const SHARMA: TombstoneView = {
  id: "inv-1",
  buyerId: "buyer-1",
  buyerName: "Sharma Traders",
  invoiceNumber: "LPC/26-27/0412",
  principalPaise: 41200000,
  principalText: "₹4,12,000",
  state: "armed",
  stateText: "Tax bomb armed: 139 days left to 31 March",
  stateRuleId: "IT-43BH",
  dueDate: "2026-10-17",
  dueDateText: "17 Oct 2026",
  daysOverdue: 26,
  interest: { paise: 512794, text: "₹5,127.94" },
  taxBomb: { status: "armed", daysLeft: 139, deductionAtRiskPaise: 41200000 },
  caveat: "registered_after_supply",
  next: { action: "advance", step: "whatsapp_nudge" },
  nextLabel: "Next: WhatsApp nudge",
  look: { heightPx: 200, moss: 2, cracked: false, ember: false, wisp: true },
  ariaLabel: "Sharma Traders, ₹4,12,000, 26 days overdue, Tax bomb armed: 139 days left to 31 March",
};

function currentLinks(html: string): string[] {
  return [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1] as string);
}

describe("TimeTravel", () => {
  it("marks Today as current when there is no override and shows no chip", () => {
    const html = renderToStaticMarkup(
      <GraveyardPendingProvider>
        <TimeTravel override={null} />
      </GraveyardPendingProvider>,
    );
    expect(currentLinks(html)).toEqual(["Today"]);
    expect(html).not.toContain("Demo date");
    expect(html).toContain('href="/?today=2027-03-10"');
    expect(html).toContain('href="/?today=2027-04-01"');
  });

  it("marks the matching preset and shows the chip with an override", () => {
    const html = renderToStaticMarkup(
      <GraveyardPendingProvider>
        <TimeTravel override="2027-03-10" />
      </GraveyardPendingProvider>,
    );
    expect(currentLinks(html)).toEqual(["10 Mar 2027 (tax-bomb week)"]);
    expect(html).toContain("Demo date: 10 Mar 2027");
  });

  it("marks no preset for another valid date but still shows the chip", () => {
    const html = renderToStaticMarkup(
      <GraveyardPendingProvider>
        <TimeTravel override="2026-12-01" />
      </GraveyardPendingProvider>,
    );
    expect(currentLinks(html)).toEqual([]);
    expect(html).toContain("Demo date: 1 Dec 2026");
  });
});

describe("Tombstone", () => {
  const html = renderToStaticMarkup(<Tombstone view={SHARMA} today="2026-11-12" />);

  it("is one link with the view's aria-label, no tabindex and no button", () => {
    expect(html.match(/<a[ >]/g)?.length).toBe(1);
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("<article");
    expect(html).toContain(`aria-label="${SHARMA.ariaLabel}"`);
    expect(html).not.toContain("<button");
  });

  it("links to the buyer's page at the invoice, with no today value without an override", () => {
    expect(html).toContain('href="/debtors/buyer-1#invoice-inv-1"');
    expect(html).not.toContain("today=");
  });

  it("puts the Demo_Override before the fragment when one is active", () => {
    const out = renderToStaticMarkup(<Tombstone view={SHARMA} today="2027-03-10" override="2027-03-10" />);
    expect(out).toContain('href="/debtors/buyer-1?today=2027-03-10#invoice-inv-1"');
  });

  it.each(["resurrected", "not_covered", "not_due", "exploded", "armed", "overdue"] as const)(
    "renders exactly one link for the %s state",
    (state) => {
      const view: TombstoneView = { ...SHARMA, state };
      for (const override of [null, "2027-03-10"] as const) {
        const out = renderToStaticMarkup(<Tombstone view={view} today="2026-11-12" override={override} />);
        const hrefs = [...out.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]);
        expect(hrefs).toEqual([
          override === null
            ? "/debtors/buyer-1#invoice-inv-1"
            : "/debtors/buyer-1?today=2027-03-10#invoice-inv-1",
        ]);
        expect(out).toContain(`aria-label="${SHARMA.ariaLabel}"`);
        expect(out).not.toContain("tabindex");
      }
    },
  );

  it("shows figures with their rule IDs, the caveat and the next step", () => {
    expect(html).toContain("Due 17 Oct 2026 · MSMED-15");
    expect(html).toContain("Overdue 26 days, interest accruing");
    expect(html).toContain("Interest ₹5,127.94 · MSMED-16");
    expect(html).toContain(">Tax bomb armed: 139 days left to 31 March</span>");
    expect(html).toContain("IT-43BH");
    expect(html).toContain("Registered on Udyam after supply: claim may be contested");
    expect(html).toContain("Next: WhatsApp nudge");
  });

  it("shows the bank-rate message when interest is null and the invoice is covered", () => {
    const view: TombstoneView = { ...SHARMA, interest: null };
    expect(renderToStaticMarkup(<Tombstone view={view} today="2026-11-12" />)).toContain(
      "Bank rate not configured for 12 Nov 2026",
    );
  });

  it("omits due date and interest for a not_covered invoice and shows MSMED-SCOPE", () => {
    const view: TombstoneView = {
      ...SHARMA,
      state: "not_covered",
      stateText: "Outside MSMED (Trader, outside MSMED)",
      stateRuleId: "MSMED-SCOPE",
      dueDate: null,
      dueDateText: null,
      interest: null,
      daysOverdue: 0,
      caveat: null,
    };
    const out = renderToStaticMarkup(<Tombstone view={view} today="2026-11-12" />);
    expect(out).not.toContain("MSMED-15");
    expect(out).not.toContain("MSMED-16");
    expect(out).not.toContain("Bank rate not configured");
    expect(out).toContain("MSMED-SCOPE");
  });
});

describe("TotalsBar", () => {
  it("shows formatINR(0) totals, counts and the rules line", () => {
    const html = renderToStaticMarkup(
      <TotalsBar
        totals={{ outstandingPaise: 0, interestAccruedPaise: 0, deductionsAtRiskPaise: 0, explodedCount: 0, paidCount: 0 }}
        rulesAsOf="2026-10-07"
        today="2026-11-12"
      />,
    );
    expect(html).toContain("₹0");
    expect(html).toContain("Exploded 0 · Resurrected 0");
    expect(html).toContain("Rules as of 7 Oct 2026");
    expect(html).toContain("MSMED-16");
    expect(html).toContain("IT-43BH");
  });

  it("shows the bank-rate message for interest and the rules line when there is no bank rate", () => {
    const html = renderToStaticMarkup(
      <TotalsBar
        totals={{ outstandingPaise: 100, interestAccruedPaise: null, deductionsAtRiskPaise: 0, explodedCount: 1, paidCount: 2 }}
        rulesAsOf={null}
        today="2026-11-12"
      />,
    );
    expect(html.split("Bank rate not configured for 12 Nov 2026").length - 1).toBe(2);
    expect(html).not.toContain("Rules as of");
  });
});

describe("LoadError", () => {
  it("renders fixed text and a plain retry link without a today value", () => {
    const html = renderToStaticMarkup(<LoadError />);
    expect(html).toContain("We couldn&#x27;t load your graveyard just now. Please try again.");
    expect(html).toContain('href="/"');
  });

  it("keeps the URL-encoded today value in the retry link", () => {
    const html = renderToStaticMarkup(<LoadError todayRaw="2027-03-10&x=1" />);
    expect(html).toContain('href="/?today=2027-03-10%26x%3D1"');
  });
});

describe("GraveyardEmpty", () => {
  it("shows the quiet text and an import link", () => {
    const html = renderToStaticMarkup(<GraveyardEmpty />);
    expect(html).toContain("The graveyard is quiet");
    expect(html).toContain('href="/import"');
    expect(html).toContain("Import invoices");
  });
});
