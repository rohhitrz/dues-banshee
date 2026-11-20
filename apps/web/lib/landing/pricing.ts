// The one money-lint exception in the landing dirs (see apps/web/test/money-lint.test.ts): this file may
// hold a rupee sign. It has product prices (integer paise, rendered with formatINR) and a cited
// statistic, not legal money. The Sharma figures never come from here.
import { TALK_TO_US_URL } from "./copy";

/** Rendered as formatINR(paise, "full") followed by `suffix`. */
export interface PlanPrice {
  paise: number;
  suffix: string;
}

export interface Plan {
  id: "free" | "banshee" | "ca" | "custom";
  name: string;
  prices: readonly PlanPrice[];
  note: string | null;
  features: readonly string[];
  cta: { label: string; href: string } | null;
}

export const PRICING_HEADING = "Cheaper than one legal notice.";
export const PRICING_LABEL = "Launch pricing (planned). The demo is free.";

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    prices: [{ paise: 0, suffix: "" }],
    note: null,
    features: ["10 open invoices", "Interest and 31 March countdowns", "WhatsApp nudges"],
    cta: null,
  },
  {
    id: "banshee",
    name: "Banshee",
    prices: [
      { paise: 99_900, suffix: "/mo" },
      { paise: 69_900, suffix: "/mo billed yearly" },
    ],
    note: null,
    features: [
      "150 open invoices",
      "Full ladder",
      "Pay links",
      "Hinglish voice calls, about 60 min per month",
      "Legal notice and Samadhaan pack",
      "Daily Kiro Crew run",
    ],
    cta: null,
  },
  {
    id: "ca",
    name: "CA firms",
    prices: [{ paise: 49_900, suffix: " per client/mo" }],
    note: "Minimum 10 clients",
    features: ["All MSME clients in one dashboard"],
    cta: null,
  },
  {
    id: "custom",
    name: "Custom",
    prices: [],
    note: null,
    features: ["High volume", "More voice minutes", "Tally sync", "Custom terms"],
    cta: { label: "Talk to us", href: TALK_TO_US_URL },
  },
];

export const PROBLEM_SIZE = {
  figure: "about ₹8.1 lakh crore",
  source: "Economic Survey figure, as reported in Recordent's Indian SME Receivables Report 2026",
} as const;
