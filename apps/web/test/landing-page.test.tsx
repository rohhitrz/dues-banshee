// Feature: landing-3d. Data tests for the /landing modules (task 1.3) and render tests for the page (task 2.3).
import { LADDER_STEPS, formatINR, taxBomb } from "@dues-banshee/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LandingPage, { metadata } from "@/app/(site)/landing/page";
import { LADDER_COPY, TALK_TO_US_URL } from "@/lib/landing/copy";
import { PLANS } from "@/lib/landing/pricing";
import { sharmaExample, sharmaInvoice } from "@/lib/landing/sharma-example";

describe("landing data", () => {
  describe("Sharma example", () => {
    it("the Engine's taxBomb on the seed is armed, 139 days left, 41,200,000 paise at risk (Req 6.2)", () => {
      // Computed here by calling the Engine, not read from sharmaExample(), so a seed or Engine change fails loudly.
      const bomb = taxBomb(sharmaInvoice(), "2026-11-12");
      expect(bomb.status).toBe("armed");
      if (bomb.status !== "armed") return;
      expect(bomb.daysLeft).toBe(139);
      expect(bomb.deductionAtRiskPaise).toBe(41_200_000);
    });

    it("sharmaExample() returns the exact display values (Req 2.4)", () => {
      const example = sharmaExample();
      expect(example.buyerName).toBe("Sharma Traders");
      expect(example.deductionAtRiskText).toBe("₹4,12,000");
      expect(example.daysLeft).toBe(139);
      expect(example.exampleDateText).toBe("12 Nov 2026");
    });
  });

  describe("ladder copy", () => {
    it("is keyed by exactly the LADDER_STEPS (Req 2.3)", () => {
      expect(Object.keys(LADDER_COPY).sort()).toEqual([...LADDER_STEPS].sort());
    });

    it("names the five steps in LADDER_STEPS order (Req 2.3)", () => {
      expect(LADDER_STEPS.map((step) => LADDER_COPY[step].name)).toEqual([
        "WhatsApp nudge",
        "WhatsApp pay link",
        "Voice call",
        "Legal notice",
        "MSME ODR pack",
      ]);
    });
  });

  describe("pricing", () => {
    it("lists the four plans in order (Req 3.2)", () => {
      expect(PLANS.map((plan) => plan.name)).toEqual(["Free", "Banshee", "CA firms", "Custom"]);
    });

    it("keeps every price as a non-negative safe integer of paise (Req 3.4)", () => {
      for (const plan of PLANS) {
        for (const price of plan.prices) {
          expect(Number.isSafeInteger(price.paise)).toBe(true);
          expect(price.paise).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it("renders the prices through formatINR as ₹0, ₹999, ₹699, ₹499 (Req 3.2, 3.4)", () => {
      const texts = PLANS.flatMap((plan) => plan.prices.map((price) => formatINR(price.paise, "full")));
      expect(texts).toEqual(["₹0", "₹999", "₹699", "₹499"]);
    });

    it("points the Custom card's Talk to us CTA at the mailto link (Req 3.3)", () => {
      const custom = PLANS.find((plan) => plan.id === "custom");
      expect(custom?.cta?.label).toBe("Talk to us");
      expect(custom?.cta?.href).toBe("mailto:rohhit.rz@gmail.com?subject=Dues%20Banshee%3A%20Custom%20plan");
      expect(TALK_TO_US_URL).toBe("mailto:rohhit.rz@gmail.com?subject=Dues%20Banshee%3A%20Custom%20plan");
    });
  });
});

// Render tests (Req 6.1). No mocks: the page has no auth, navigation or database imports.
// renderToStaticMarkup escapes ' as &#x27; (and & as &amp;), so expected strings are written escaped,
// as in not-found.test.tsx.
const SECTIONS = [
  "Hero",
  "Ladder",
  "Tax bomb",
  "Problem size",
  "CA firms",
  "Pricing",
  "Roadmap",
  "Built with Kiro",
  "Footer",
] as const;
type SectionName = (typeof SECTIONS)[number];

const DISCLAIMER = "Reminders a supplier sends to its own buyers. Not legal advice.";

describe("LandingPage render", () => {
  const html = renderToStaticMarkup(<LandingPage />);
  const startOf = (name: SectionName) => html.indexOf(`aria-label="${name}"`);

  /** The markup from one section's opening tag to the start of the next section (or the end). */
  const slice = (name: SectionName): string => {
    const index = SECTIONS.indexOf(name);
    const next = SECTIONS[index + 1];
    const end = next === undefined ? html.length : startOf(next);
    return html.slice(startOf(name), end);
  };

  /** Finds the opening tag of the <a> with this href inside `markup`. */
  const anchorTag = (markup: string, href: string): string | undefined =>
    markup.match(new RegExp(`<a [^>]*href="${href.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"[^>]*>`))?.[0];

  /** Asserts the strings appear in `markup` in the given order. */
  const expectInOrder = (markup: string, texts: readonly string[]) => {
    let from = 0;
    for (const text of texts) {
      const at = markup.indexOf(text, from);
      expect(at, `"${text}" should appear after position ${from}`).toBeGreaterThanOrEqual(0);
      from = at + text.length;
    }
  };

  it("exports the exact title and no social images (Req 1.6)", () => {
    expect(metadata.title).toBe("Dues Banshee — They forgot your invoice. The taxman won't.");
    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.twitter?.images).toBeUndefined();
  });

  it("renders the nine sections in order (Req 2.1)", () => {
    const positions = SECTIONS.map(startOf);
    for (const position of positions) expect(position).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], `${SECTIONS[i]} should come after ${SECTIONS[i - 1]}`).toBeGreaterThan(positions[i - 1] ?? -1);
    }
    expect(html).toMatch(/<footer aria-label="Footer"/);
  });

  it("Hero has the <h1> and the Enter the demo link to /signin (Req 2.2)", () => {
    const hero = slice("Hero");
    expect(hero).toMatch(/<h1[^>]*>They forgot your invoice\. The taxman won&#x27;t\.<\/h1>/);
    expect(hero).toMatch(/<a [^>]*href="\/signin"[^>]*>Enter the demo<\/a>/);
  });

  it("Ladder lists the five steps in order and the full Voice call line (Req 2.3)", () => {
    const ladder = slice("Ladder");
    expectInOrder(ladder, ["WhatsApp nudge", "WhatsApp pay link", "Voice call", "Legal notice", "MSME ODR pack"]);
    expect(ladder).toContain("An AI call over the internet, in Hinglish. Phone (PSTN) calls are on the roadmap.");
    expect(ladder).toContain("The owner approves every step before anything is sent.");
  });

  it("Tax bomb shows the Sharma values and both rule IDs, with no interest amount (Req 2.4-2.6)", () => {
    const bomb = slice("Tax bomb");
    expect(bomb).toContain("₹4,12,000");
    expect(bomb).toContain("139");
    expect(bomb).toContain("12 Nov 2026");
    expect(bomb).toContain("IT-43BH");
    expect(bomb).toContain("MSMED-16");
    expect(bomb).toContain("Income-tax Act 1961 s.43B(h); Income-tax Act 2025 s.37(2)(g)");
    expect(bomb).toContain("The return-filing grace period does not apply.");
    // Only the deduction at risk is a rupee amount: no interest figure (needs the DB bank rate).
    expect(bomb.match(/₹[\d,]+/g)).toEqual(["₹4,12,000"]);
  });

  it("Problem size shows the figure and names its source (Req 2.7)", () => {
    const problem = slice("Problem size");
    expect(problem).toContain("about ₹8.1 lakh crore");
    expect(problem).toContain(
      "Economic Survey figure, as reported in Recordent&#x27;s Indian SME Receivables Report 2026",
    );
  });

  it("CA firms states the books and one-dashboard claims (Req 2.8)", () => {
    const ca = slice("CA firms");
    expect(ca).toContain("CAs already keep their MSME clients&#x27; books.");
    expect(ca).toContain("One dashboard runs collections for all their clients.");
  });

  it("Pricing has the heading, label, four cards in order and the four prices (Req 3.1-3.3)", () => {
    const pricing = slice("Pricing");
    expect(pricing).toContain("Cheaper than one legal notice.");
    expect(pricing).toContain("Launch pricing (planned). The demo is free.");
    expectInOrder(pricing, [">Free</h3>", ">Banshee</h3>", ">CA firms</h3>", ">Custom</h3>"]);
    expectInOrder(pricing, ["₹0", "₹999", "₹699", "₹499"]);
    expect(pricing).toContain("/mo billed yearly");
    expect(pricing).toContain("per client/mo");
    expect(pricing).toContain("Minimum 10 clients");

    // mailto is not an External_Link: a plain <a href>, no target and no rel.
    const talk = anchorTag(pricing, TALK_TO_US_URL);
    expect(talk).toContain('href="mailto:rohhit.rz@gmail.com?subject=Dues%20Banshee%3A%20Custom%20plan"');
    expect(talk).not.toContain("target=");
    expect(talk).not.toContain("rel=");
    expect(pricing).toMatch(/<a [^>]*>Talk to us<\/a>/);
  });

  it("Roadmap lists the four items (Req 2.9)", () => {
    expectInOrder(slice("Roadmap"), [
      "Phone (PSTN) calls",
      "Tally sync",
      "Auto-send WhatsApp after Meta verification",
      "An AI sales agent on calls",
    ]);
  });

  it("Built with Kiro links to the Crew repo as an external link (Req 2.10)", () => {
    const kiro = slice("Built with Kiro");
    expect(kiro).toContain("runs the ladder every morning at 9");
    const link = anchorTag(kiro, "https://github.com/rohhitrz/dues-banshee-crew");
    expect(link).toBeDefined();
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
  });

  it("Footer shows the Kiroween line and the page never repeats the Disclaimer (Req 2.11)", () => {
    expect(slice("Footer")).toContain("Built for Kiroween 2026.");
    expect(html).not.toContain(DISCLAIMER);
  });

  it("has no form and no Razorpay link (Req 3.5)", () => {
    expect(html).not.toContain("<form");
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.toLowerCase()).not.toContain("razorpay");
  });
});
