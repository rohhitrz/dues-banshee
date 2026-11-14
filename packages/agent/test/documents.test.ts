// Legal_Notice and ODR_Pack PDFs for Sharma Traders at Today 2026-11-12 (Bank_Rate 575 bps as of 2026-10-07).
// Requirements: 8.1, 8.2, 8.3, 8.4, 12.8
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DEMO_INVOICES, DEMO_SUPPLIER, toEngineInvoice } from "@dues-banshee/db";
import type { InvoiceRow, SupplierRow } from "@dues-banshee/db";
import { RULE_SOURCES, formatINR } from "@dues-banshee/engine";
import type { BankRate, RuleId } from "@dues-banshee/engine";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { buildFactSheet } from "../src/core/fact-sheet";
import { DISCLAIMER, buildFinalText } from "../src/core/final-text";
import { FONT_FILES } from "../src/io/documents/legal-notice";
import { renderDocument } from "../src/io/documents/render";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";

const SUPPLIER_ROW: SupplierRow = { id: SUPPLIER_ID, ...DEMO_SUPPLIER, createdAt: new Date(0) };
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

const FACTS = buildFactSheet(
  {
    invoice: toEngineInvoice(INVOICE_ROW, SUPPLIER_ROW),
    buyerName: SHARMA.buyerName,
    invoiceNumber: SHARMA.invoiceNumber,
  },
  TODAY,
  BANK_RATE,
);
const SUPPLIER = { name: DEMO_SUPPLIER.name, udyamNumber: DEMO_SUPPLIER.udyamNumber };
const RULE_IDS: readonly RuleId[] = ["MSMED-15", "MSMED-16", "IT-43BH", "MSMED-2B"];

const HEADER = "DRAFT \u2013 for the owner's review";
const ODR_LINE = "File on the MSME ODR portal (odr.msme.gov.in)";
const CAVEAT = "The supplier registered on Udyam after this supply; the claim may be contested.";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

async function pages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map(norm);
}

function finalTextOf(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `Line ${i + 1}: ${FACTS.buyer_name} ji, invoice ${FACTS.invoice_number}.`).join("\n");
  return buildFinalText(body, RULE_IDS);
}

describe("Legal_Notice and ODR_Pack documents for Sharma Traders", () => {
  it("demo facts are the exact Sharma values", () => {
    expect(FACTS.principal).toEqual(formatINR(41200000, "full"));
    expect(FACTS.interest).toEqual(formatINR(512794, "full"));
    expect(FACTS.principal.startsWith("\u20B9")).toBe(true);
    expect(FACTS.interest?.startsWith("\u20B9")).toBe(true);
    expect(FACTS.due_date).toEqual("17 Oct 2026");
    expect(FACTS.rate_as_of).toEqual("7 Oct 2026");
  });

  it("registers Noto Sans files that exist and never references Helvetica in the PDF", async () => {
    expect(existsSync(FONT_FILES.regular)).toBe(true);
    expect(existsSync(FONT_FILES.bold)).toBe(true);
    expect(isAbsolute(FONT_FILES.regular)).toBe(true);
    expect(isAbsolute(FONT_FILES.bold)).toBe(true);
    for (const kind of ["legal_notice", "odr_pack"] as const) {
      const bytes = await renderDocument(kind, {
        supplier: SUPPLIER,
        facts: FACTS,
        ruleIds: RULE_IDS,
        finalText: finalTextOf(3),
        caveat: undefined,
      });
      const raw = Buffer.from(bytes).toString("latin1");
      expect(raw).not.toContain("Helvetica");
      expect(raw).toContain("NotoSans");
    }
  });

  it("legal_notice shows every Fact_Sheet value, each rule with its source, the header and the Disclaimer", async () => {
    const bytes = await renderDocument("legal_notice", {
      supplier: SUPPLIER,
      facts: FACTS,
      ruleIds: RULE_IDS,
      finalText: finalTextOf(3),
      caveat: undefined,
    });
    const text = (await pages(bytes)).join(" ");

    expect(text).toContain(norm(DEMO_SUPPLIER.name));
    expect(text).toContain(DEMO_SUPPLIER.udyamNumber);
    expect(text).toContain("Sharma Traders");
    expect(text).toContain("LPC/26-27/0412");
    expect(text).toContain(`Principal ${formatINR(41200000, "full")}`);
    expect(text).toContain("Due date 17 Oct 2026");
    expect(text).toContain(`Interest ${formatINR(512794, "full")} (rate as of 7 Oct 2026)`);
    for (const id of RULE_IDS) expect(text).toContain(`${id} (${RULE_SOURCES[id]})`);
    // Rule lines appear in Basis_Line order.
    const positions = RULE_IDS.map((id) => text.indexOf(`${id} (${RULE_SOURCES[id]})`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text).toContain(norm(DISCLAIMER));
    expect(text).toContain("Line 3: Sharma Traders ji, invoice LPC/26-27/0412.");

    expect(text).not.toContain(ODR_LINE);
    expect(text).not.toContain("MSMED-ODR");
    expect(text).not.toContain(CAVEAT);
  });

  it("odr_pack adds the ODR line with MSMED-ODR and MSMED-18 and their sources", async () => {
    const bytes = await renderDocument("odr_pack", {
      supplier: SUPPLIER,
      facts: FACTS,
      ruleIds: RULE_IDS,
      finalText: finalTextOf(3),
      caveat: undefined,
    });
    const text = (await pages(bytes)).join(" ");

    expect(text).toContain(ODR_LINE);
    expect(text).toContain(`MSMED-ODR (${RULE_SOURCES["MSMED-ODR"]})`);
    expect(text).toContain(`MSMED-18 (${RULE_SOURCES["MSMED-18"]})`);
    expect(text).toContain(`Principal ${formatINR(41200000, "full")}`);
    expect(text).toContain(`Interest ${formatINR(512794, "full")} (rate as of 7 Oct 2026)`);
    expect(text).toContain(norm(DISCLAIMER));
    expect(text).not.toContain(CAVEAT);
  });

  it("repeats the DRAFT header on every page of a multi-page document", async () => {
    for (const kind of ["legal_notice", "odr_pack"] as const) {
      const bytes = await renderDocument(kind, {
        supplier: SUPPLIER,
        facts: FACTS,
        ruleIds: RULE_IDS,
        finalText: finalTextOf(150),
        caveat: undefined,
      });
      const perPage = await pages(bytes);
      expect(perPage.length).toBeGreaterThan(1);
      for (const page of perPage) expect(page).toContain(HEADER);
    }
  });

  it("includes the caveat sentence only when the caveat is registered_after_supply", async () => {
    for (const kind of ["legal_notice", "odr_pack"] as const) {
      const base = { supplier: SUPPLIER, facts: FACTS, ruleIds: RULE_IDS, finalText: finalTextOf(3) };
      const withCaveat = (await pages(await renderDocument(kind, { ...base, caveat: "registered_after_supply" }))).join(" ");
      const without = (await pages(await renderDocument(kind, { ...base, caveat: undefined }))).join(" ");
      expect(withCaveat).toContain(CAVEAT);
      expect(without).not.toContain(CAVEAT);
    }
  });
});
