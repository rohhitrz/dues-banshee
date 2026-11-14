// Exact demo literals for Sharma Traders at Today 2026-11-12 (no tolerances).
// Requirements: 1.1, 5.2, 5.8, 11.3, 12.3, 12.4
import { DEMO_INVOICES, DEMO_SUPPLIER, toEngineInvoice } from "@dues-banshee/db";
import type { InvoiceRow, SupplierRow } from "@dues-banshee/db";
import {
  RULE_IDS,
  formatINR,
  nextEscalationStep,
  statutoryInterest,
} from "@dues-banshee/engine";
import type { BankRate, EscalationDecision, Invoice } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { allowedRuleIds } from "../src/core/allowed-rule-ids";
import { validateCitations } from "../src/core/citations";
import { buildFactSheet, fillPlaceholders } from "../src/core/fact-sheet";
import { DISCLAIMER, buildFinalText } from "../src/core/final-text";
import { engineHistory } from "../src/core/history";
import type { ModelOutput } from "../src/core/model-output";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER_ROW: SupplierRow = {
  id: SUPPLIER_ID,
  ...DEMO_SUPPLIER,
  createdAt: new Date(0),
};

const SHARMA = DEMO_INVOICES[0];
if (SHARMA === undefined) throw new Error("DEMO_INVOICES[0] missing");

const INVOICE_ROW: InvoiceRow = {
  id: "inv-sharma",
  supplierId: SUPPLIER_ID,
  buyerId: "buyer-inv-sharma",
  invoiceNumber: SHARMA.invoiceNumber,
  invoiceNumberKey: SHARMA.invoiceNumber.toLowerCase(),
  invoiceDate: SHARMA.acceptedOn,
  acceptedOn: SHARMA.acceptedOn,
  acceptanceDateDefaulted: false,
  agreedTermDays: SHARMA.agreedTermDays ?? null,
  amountPaise: SHARMA.amountPaise,
  paidOn: SHARMA.paidOn ?? null,
  supplierCategory: SUPPLIER_ROW.supplierCategory,
  supplierActivity: SUPPLIER_ROW.supplierActivity,
  createdAt: new Date(0),
};

const INVOICE: Invoice = toEngineInvoice(INVOICE_ROW, SUPPLIER_ROW);
const HISTORY = engineHistory({ steps: [], promises: [] });
const DECISION: EscalationDecision = nextEscalationStep(INVOICE, HISTORY, TODAY);
const FACTS = {
  invoice: INVOICE,
  invoiceDate: INVOICE_ROW.invoiceDate,
  acceptanceDateDefaulted: INVOICE_ROW.acceptanceDateDefaulted,
};

describe("Sharma Traders demo at 2026-11-12", () => {
  it("is the Sharma seed row", () => {
    expect(SHARMA.buyerName).toEqual("Sharma Traders");
    expect(SHARMA.invoiceNumber).toEqual("LPC/26-27/0412");
    expect(SHARMA.amountPaise).toEqual(41200000);
  });

  it("Engine decision is the WhatsApp nudge, no approval, citing MSMED-15", () => {
    expect(DECISION).toEqual({
      action: "advance",
      applicable: true,
      step: "whatsapp_nudge",
      rank: 1,
      requiresApproval: false,
      ruleIds: ["MSMED-15"],
    });
  });

  it("Allowed_Rule_IDs add MSMED-2B because the acceptance date equals the invoice date", () => {
    expect(INVOICE_ROW.acceptanceDateDefaulted).toEqual(false);
    expect(INVOICE.acceptedOn).toEqual(INVOICE_ROW.invoiceDate);
    expect(allowedRuleIds(FACTS, DECISION, TODAY, BANK_RATE)).toEqual([
      "MSMED-15",
      "MSMED-16",
      "IT-43BH",
      "MSMED-2B",
    ]);
  });

  it("Fact_Sheet holds the exact demo values", () => {
    const interest = statutoryInterest(INVOICE, TODAY, BANK_RATE);
    expect(interest.applicable && interest.interestPaise).toEqual(512794);

    expect(
      buildFactSheet(
        { invoice: INVOICE, buyerName: SHARMA.buyerName, invoiceNumber: SHARMA.invoiceNumber },
        TODAY,
        BANK_RATE,
      ),
    ).toEqual({
      buyer_name: "Sharma Traders",
      invoice_number: "LPC/26-27/0412",
      principal: formatINR(41200000, "full"),
      due_date: "17 Oct 2026",
      interest: formatINR(512794, "full"),
      rate_as_of: "7 Oct 2026",
      tax_bomb_date: "31 Mar 2027",
      tax_bomb_days: "139",
      deduction_at_risk: formatINR(41200000, "full"),
      pay_link: "[payment link added on send]",
    });
  });

  it("builds the exact Final_Text from a fixed Model_Output", () => {
    const allowed = allowedRuleIds(FACTS, DECISION, TODAY, BANK_RATE);
    const output: ModelOutput = {
      text:
        "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} {{due_date}} ko due tha. " +
        "Tab se {{interest}} byaaj jud chuka hai ({{rate_as_of}} ki bank rate par). " +
        "Kripya {{pay_link}} se bhugtan kar dein.",
      ruleIds: ["MSMED-15", "MSMED-16"],
    };

    const verdict = validateCitations(output, allowed, RULE_IDS, true);
    expect(verdict).toEqual({ ok: true, ruleIds: ["MSMED-15", "MSMED-16"] });
    if (!verdict.ok) return;

    const facts = buildFactSheet(
      { invoice: INVOICE, buyerName: SHARMA.buyerName, invoiceNumber: SHARMA.invoiceNumber },
      TODAY,
      BANK_RATE,
    );
    const body = fillPlaceholders(output.text, facts);
    const principal = formatINR(41200000, "full");
    const interest = formatINR(512794, "full");
    expect(body).toEqual(
      `Namaste Sharma Traders ji, invoice LPC/26-27/0412 ka ${principal} 17 Oct 2026 ko due tha. ` +
        `Tab se ${interest} byaaj jud chuka hai (7 Oct 2026 ki bank rate par). ` +
        "Kripya [payment link added on send] se bhugtan kar dein.",
    );

    const basis = "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)";
    const finalText = buildFinalText(body, verdict.ruleIds);
    expect(finalText).toEqual(
      `${body}\n\n${basis}\nReminders a supplier sends to its own buyers. Not legal advice.`,
    );
    expect(finalText.split("\n")[finalText.split("\n").length - 2]).toEqual(basis);
    expect(finalText.split("\n").at(-1)).toEqual(DISCLAIMER);
  });
});
