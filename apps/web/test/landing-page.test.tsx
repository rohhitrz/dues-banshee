// Feature: landing-3d. Data tests for the /landing modules (tasks 1.3). Render tests join this file in task 2.3.
import { LADDER_STEPS, formatINR, taxBomb } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
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
        "Samadhaan pack",
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

    it("points the Custom card's Talk to us CTA at the LinkedIn profile (Req 3.3)", () => {
      const custom = PLANS.find((plan) => plan.id === "custom");
      expect(custom?.cta?.label).toBe("Talk to us");
      expect(custom?.cta?.href).toBe("https://www.linkedin.com/in/rohitraaj");
      expect(TALK_TO_US_URL).toBe("https://www.linkedin.com/in/rohitraaj");
    });
  });
});
