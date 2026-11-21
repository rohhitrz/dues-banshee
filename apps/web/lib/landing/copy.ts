// Text for the public /landing page. No amounts live here: the Sharma figures come from the Engine
// (sharma-example.ts) and plan prices from pricing.ts, so this file holds no rupee sign.
import type { LadderStep, RuleId } from "@dues-banshee/engine";

export const HERO = {
  title: "They forgot your invoice. The taxman won't.",
  subline:
    "AI collections for Udyam micro and small suppliers: a polite WhatsApp nudge, a Hinglish call, then a legal notice. The owner approves every step.",
  cta: { label: "Enter the demo", href: "/signin" },
} as const;

/** Keyed by LadderStep: a step added to or removed from LADDER_STEPS fails type-checking here. */
export const LADDER_COPY = {
  whatsapp_nudge: {
    name: "WhatsApp nudge",
    line: "A polite reminder in Hinglish or English, with the invoice number and the date it fell due.",
  },
  whatsapp_paylink: {
    name: "WhatsApp pay link",
    line: "A second message with a payment link for the invoice amount, so the buyer can pay in one tap.",
  },
  voice_call: {
    name: "Voice call",
    line: "An AI call over the internet, in Hinglish. Phone (PSTN) calls are on the roadmap.",
  },
  legal_notice: {
    name: "Legal notice",
    line: "A drafted notice that cites the MSMED Act, ready for the owner to download and send.",
  },
  odr_pack: {
    name: "MSME ODR pack",
    line: "The papers for a claim on the MSME ODR portal, drafted for the owner to review and file.",
  },
} as const satisfies Record<LadderStep, { name: string; line: string }>;

export const LADDER_APPROVAL = "The owner approves every step before anything is sent.";

const IT_43BH: RuleId = "IT-43BH";
const MSMED_16: RuleId = "MSMED-16";

export const TAX_BOMB_COPY = {
  rule: "An invoice already past its MSMED s.15 time limit and still unpaid on 31 March costs the buyer that year's deduction. The return-filing grace period does not apply.",
  ruleId: IT_43BH,
  ruleSource: "Income-tax Act 1961 s.43B(h); Income-tax Act 2025 s.37(2)(g)",
  interest: "Late payment also carries compound interest with monthly rests at 3× the RBI bank rate.",
  interestRuleId: MSMED_16,
} as const;

export const CA_COPY =
  "CAs already keep their MSME clients' books. One dashboard runs collections for all their clients.";

export const ROADMAP_ITEMS = [
  "Phone (PSTN) calls",
  "Tally sync",
  "Auto-send WhatsApp after Meta verification",
  "An AI sales agent on calls",
] as const;

export const CREW_COPY = {
  text: "A Kiro Crew app runs the ladder every morning at 9. It only drafts messages; the owner approves them.",
  linkLabel: "dues-banshee-crew on GitHub",
  href: "https://github.com/rohhitrz/dues-banshee-crew",
} as const;

export const TALK_TO_US_URL = "mailto:rohhit.rz@gmail.com?subject=Dues%20Banshee%3A%20Custom%20plan";

export const KIROWEEN_LINE = "Built for Kiroween 2026.";
