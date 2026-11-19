// Draft eval fixtures run through the same loader and runner as `pnpm … eval`. Offline, no LLM.
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_INVOICES, DEMO_SUPPLIER, toEngineInvoice } from "@dues-banshee/db";
import type { InvoiceRow, SupplierRow } from "@dues-banshee/db";
import { LADDER_STEPS, nextEscalationStep, stepRank } from "@dues-banshee/engine";
import type { BankRate, EscalationHistory, Invoice } from "@dues-banshee/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedRuleIds } from "../src/core/allowed-rule-ids";
import { FixtureError, loadFixtures } from "../src/evals/fixture";
import type { Fixture } from "../src/evals/fixture";
import { formatReport, runEvals } from "../src/evals/run";
import type { EvalResult } from "../src/evals/run";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

const FIXTURES = loadFixtures();
const RESULTS = runEvals(FIXTURES);

function byName(name: string): Fixture {
  const found = FIXTURES.find((f) => f.name === name);
  if (found === undefined) throw new Error(`fixture ${name} missing`);
  return found;
}

describe("draft eval fixtures", () => {
  describe.each(FIXTURES.map((f) => [f.name, f] as const))("%s", (name, fixture) => {
    it("actual result equals Expected_Result", () => {
      const result = RESULTS.find((r) => r.name === name);
      expect(result).toBeDefined();
      expect(result?.actual).toEqual(fixture.expected);
      expect(result?.pass).toBe(true);
    });
  });

  it("loads in name order", () => {
    // File names equal fixture names, so reading in file-name order returns sorted names.
    const names = FIXTURES.map((f) => f.name);
    expect([...names].sort()).toEqual(names);
  });
});

describe("coverage (Req 4.2)", () => {
  const accepts = FIXTURES.filter((f) => f.expected === "accept");
  const expecting = (reason: string, language: "hinglish" | "english") =>
    FIXTURES.filter((f) => f.expected === reason && f.context.language === language);

  it("holds 15 to 20 fixtures with unique names", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15);
    expect(FIXTURES.length).toBeLessThanOrEqual(20);
    expect(new Set(FIXTURES.map((f) => f.name)).size).toEqual(FIXTURES.length);
  });

  it("has at least 3 accept fixtures, in both languages", () => {
    expect(accepts.length).toBeGreaterThanOrEqual(3);
    expect(accepts.some((f) => f.context.language === "hinglish")).toBe(true);
    expect(accepts.some((f) => f.context.language === "english")).toBe(true);
  });

  it.each(["missing_address", "threat_phrase", "begging_phrase", "overdue_tense"])(
    "has %s in Hinglish and in English",
    (reason) => {
      expect(expecting(reason, "hinglish").length).toBeGreaterThanOrEqual(1);
      expect(expecting(reason, "english").length).toBeGreaterThanOrEqual(1);
    },
  );

  it("has at least one each of missing_citation, invalid_rule_id and uncited_placeholder", () => {
    for (const reason of ["missing_citation", "invalid_rule_id", "uncited_placeholder"]) {
      expect(FIXTURES.some((f) => f.expected === reason)).toBe(true);
    }
    expect(FIXTURES.find((f) => f.expected === "missing_citation")?.output.ruleIds).toEqual([]);
    expect(
      FIXTURES.find((f) => f.expected === "invalid_rule_id")?.output.ruleIds.join(" "),
    ).toContain("MSMED-99");
    const uncited = FIXTURES.find((f) => f.expected === "uncited_placeholder");
    expect(uncited?.output.text).toContain("{{interest}}");
    expect(uncited?.output.ruleIds).not.toContain("MSMED-16");
  });

  it("has an accept near-miss: polite 'please'", () => {
    expect(
      accepts.some((f) => /\bplease\b/i.test(f.output.text) && f.context.language === "english"),
    ).toBe(true);
  });

  it("has an accept near-miss: factual statutory interest cited as MSMED-16", () => {
    expect(
      accepts.some(
        (f) => f.output.text.includes("{{interest}}") && f.output.ruleIds.includes("MSMED-16"),
      ),
    ).toBe(true);
  });

  it("has an accept near-miss: past-tense due date on an Overdue invoice", () => {
    expect(
      accepts.some(
        (f) =>
          f.context.overdue &&
          (f.output.text.includes("{{due_date}} ko due tha") ||
            f.output.text.includes("was due on {{due_date}}")),
      ),
    ).toBe(true);
  });

  it("has an accept near-miss: `{{principal}} abhi bhi due hai` on an Overdue invoice", () => {
    expect(
      accepts.some(
        (f) => f.context.overdue && f.output.text.includes("{{principal}} abhi bhi due hai"),
      ),
    ).toBe(true);
  });

  it("has an English legal_notice that states the Facilitation Council remedy and is accepted", () => {
    expect(
      accepts.some(
        (f) =>
          f.context.step === "legal_notice" &&
          f.context.language === "english" &&
          /Facilitation Council/.test(f.output.text),
      ),
    ).toBe(true);
  });

  it("has the roadmap tense pair", () => {
    const literal = FIXTURES.filter(
      (f) => f.output.text.includes("17 Oct 2026 ko due hai") && f.expected === "literal_figure",
    );
    expect(literal.length).toBeGreaterThanOrEqual(1);
    const tense = FIXTURES.filter(
      (f) =>
        f.output.text.includes("{{due_date}} ko due hai") &&
        f.context.overdue &&
        f.expected === "overdue_tense",
    );
    expect(tense.length).toBeGreaterThanOrEqual(1);
  });

  it("covers an accept of the same future-tense text on a not-Overdue invoice", () => {
    expect(
      accepts.some(
        (f) =>
          !f.context.overdue &&
          f.context.subject === "synthetic" &&
          f.output.text.includes("{{due_date}} ko due hai"),
      ),
    ).toBe(true);
  });
});

describe("demo-context check (Req 4.3)", () => {
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
  const INVOICE: Invoice = toEngineInvoice(INVOICE_ROW, SUPPLIER_ROW);
  const FACTS = {
    invoice: INVOICE,
    invoiceDate: INVOICE_ROW.invoiceDate,
    acceptanceDateDefaulted: INVOICE_ROW.acceptanceDateDefaulted,
  };

  const sharmaFixtures = FIXTURES.filter((f) => f.context.subject === "sharma_2026_11_12");

  it("has Sharma fixtures to check", () => {
    expect(sharmaFixtures.length).toBeGreaterThanOrEqual(10);
  });

  it("uses the Sharma seed row, due 2026-10-17", () => {
    expect(SHARMA.buyerName).toEqual("Sharma Traders");
    expect(INVOICE.acceptedOn).toEqual(INVOICE_ROW.invoiceDate);
  });

  it.each(sharmaFixtures.map((f) => [f.name, f] as const))(
    "%s: Engine advances to the fixture's step with the fixture's allowed rule IDs",
    (_name, fixture) => {
      const history: EscalationHistory = LADDER_STEPS.filter(
        (s) => stepRank(s) < stepRank(fixture.context.step),
      ).map((step) => ({ kind: "step", step, on: "2026-10-18" }));

      const decision = nextEscalationStep(INVOICE, history, TODAY);
      expect(decision.action).toEqual("advance");
      if (decision.action !== "advance") return;
      expect(decision.step).toEqual(fixture.context.step);

      const bankRate = fixture.context.bankRateExists ? BANK_RATE : null;
      expect(fixture.context.allowed).toEqual(allowedRuleIds(FACTS, decision, TODAY, bankRate));
      expect(fixture.context.overdue).toBe(true);
    },
  );
});

describe("loadFixtures errors (Req 4.5)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "draft-evals-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws FixtureError naming the file on bad JSON", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    const error = captured(() => loadFixtures(dir));
    expect(error).toBeInstanceOf(FixtureError);
    expect((error as FixtureError).file).toEqual(file);
  });

  it("throws FixtureError on a schema failure", () => {
    const file = join(dir, "schema.json");
    writeFileSync(file, JSON.stringify({ ...byName("accept-hinglish-nudge"), expected: "not_a_reason" }));
    const error = captured(() => loadFixtures(dir));
    expect(error).toBeInstanceOf(FixtureError);
    expect((error as FixtureError).file).toEqual(file);
    expect((error as FixtureError).issues.join(" ")).toContain("expected");
  });

  it("throws FixtureError on an unknown key (strict schema)", () => {
    writeFileSync(join(dir, "extra.json"), JSON.stringify({ ...byName("accept-hinglish-nudge"), extra: 1 }));
    expect(() => loadFixtures(dir)).toThrow(FixtureError);
  });

  it("throws FixtureError on a duplicate name", () => {
    const fixture = byName("accept-hinglish-nudge");
    writeFileSync(join(dir, "a.json"), JSON.stringify(fixture));
    writeFileSync(join(dir, "b.json"), JSON.stringify(fixture));
    const error = captured(() => loadFixtures(dir));
    expect(error).toBeInstanceOf(FixtureError);
    expect((error as FixtureError).file).toEqual(join(dir, "b.json"));
    expect((error as FixtureError).issues.join(" ")).toContain("duplicate");
  });

  it("throws FixtureError when the folder has no fixture files", () => {
    expect(() => loadFixtures(dir)).toThrow(FixtureError);
    writeFileSync(join(dir, "notes.txt"), "not a fixture");
    expect(() => loadFixtures(dir)).toThrow(FixtureError);
  });

  it("throws FixtureError when the folder does not exist", () => {
    expect(() => loadFixtures(join(dir, "missing"))).toThrow(FixtureError);
  });

  it("loads a valid folder", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "ok.json"), JSON.stringify(byName("accept-hinglish-nudge")));
    expect(loadFixtures(dir).map((f) => f.name)).toEqual(["accept-hinglish-nudge"]);
  });
});

describe("formatReport (Req 4.4)", () => {
  it("ends with `<passed>/<total> passed` on a mixed result", () => {
    const results: EvalResult[] = [
      { name: "one", expected: "accept", actual: "accept", pass: true },
      { name: "two", expected: "threat_phrase", actual: "accept", pass: false },
      { name: "three", expected: "missing_address", actual: "missing_address", pass: true },
    ];
    const lines = formatReport(results).split("\n");
    expect(lines).toEqual([
      "PASS one  expected=accept  actual=accept",
      "FAIL two  expected=threat_phrase  actual=accept",
      "PASS three  expected=missing_address  actual=missing_address",
      "2/3 passed",
    ]);
  });

  it("reports every real fixture as passed", () => {
    const lines = formatReport(RESULTS).split("\n");
    expect(lines.at(-1)).toEqual(`${FIXTURES.length}/${FIXTURES.length} passed`);
    expect(lines.length).toEqual(FIXTURES.length + 1);
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
