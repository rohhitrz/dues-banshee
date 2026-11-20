// Node types are needed for node:fs and fileURLToPath.
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Feature: dashboard-ui, Req 3.5: money is integer paise; no float parsing or formatting in graveyard code.

interface Offence {
  line: number;
  token: string;
}

const BANNED: readonly { token: string; pattern: RegExp }[] = [
  { token: "toFixed", pattern: /toFixed/ },
  { token: "parseFloat", pattern: /parseFloat/ },
  { token: "Number(", pattern: /\bNumber\(/ },
];

/** Returns every banned-token occurrence in `source` with its 1-based line number. */
function findOffences(source: string): Offence[] {
  const offences: Offence[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    for (const { token, pattern } of BANNED) {
      if (pattern.test(text)) offences.push({ line: index + 1, token });
    }
  });
  return offences;
}

/** All .ts/.tsx files under `dir`, recursively. A missing directory yields no files. */
function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry)) files.push(full);
  }
  return files.sort();
}

// apps/web/test -> apps/web
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Feature: crew-api, Req 5.3: the crew route and mapper are scanned too (missing dirs yield no files).
const SCANNED_DIRS = ["lib/graveyard", "components/graveyard", "app/api/crew", "lib/crew"].map((d) => join(WEB_ROOT, d));
// Feature: debtor-ui, Req 4.5: the same ban, plus float division, on the debtor screen.
const DEBTOR_DIRS = ["lib/debtor", "components/debtor", "app/(debtor)"].map((d) => join(WEB_ROOT, d));

// Feature: landing-3d, Req 5.1: the same ban, plus division and the rupee sign, on the public landing page.
// A missing app dir (page not built yet) yields no files.
const LANDING_DIRS = ["app/(site)/landing", "lib/landing"].map((d) => join(WEB_ROOT, d));
// Feature: landing-3d, Req 5.2: the Pricing_File is the one landing file allowed a ₹ sign. It holds
// product prices and a cited statistic, not legal money; Sharma values must come from formatINR.
const RUPEE_EXCEPTION = "lib/landing/pricing.ts";

/** Returns the 1-based lines of `source` containing "₹", or [] when `relPath` is the documented exception. */
function findRupeeSigns(relPath: string, source: string): number[] {
  if (relPath === RUPEE_EXCEPTION) return [];
  const lines: number[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    if (text.includes("₹")) lines.push(index + 1);
  });
  return lines;
}

/** Blanks comments and string/template text so only code operators remain. `${...}` expressions are kept. */
function codeOnly(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  out = out.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  // Keep only the ${...} parts of template literals (one nesting level is enough here).
  out = out.replace(/`((?:[^`\\]|\\.)*)`/g, (_m, body: string) => {
    const parts = [...body.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1] ?? "");
    return parts.length === 0 ? '""' : `(${parts.join(", ")})`;
  });
  return out;
}

/** Returns the 1-based lines of `source` that divide one operand by another with the `/` operator. */
function findDivisions(source: string): number[] {
  const lines: number[] = [];
  codeOnly(source)
    .split(/\r?\n/)
    .forEach((text, index) => {
      // `</tag>` and `/>` have no operand on the left or right, regex literals follow an operator or `(`.
      if (/[\w)\]]\s*\/\s*[\w(]/.test(text)) lines.push(index + 1);
    });
  return lines;
}

describe("money lint scanner", () => {
  it("detects each banned token with its line number", () => {
    const source = ["const a = 1;", "x.toFixed(2);", "parseFloat(s);", "const n = Number(s);", "Number.isSafeInteger(n);"].join("\n");
    expect(findOffences(source)).toEqual([
      { line: 2, token: "toFixed" },
      { line: 3, token: "parseFloat" },
      { line: 4, token: "Number(" },
    ]);
  });

  it("reports nothing for clean integer-paise code", () => {
    expect(findOffences("const p = parseInt(s, 10);\nconst ok = Number.isSafeInteger(p);\n")).toEqual([]);
  });

  it("detects division but not comments, strings, paths, closing tags or regex literals", () => {
    expect(findDivisions("const a = total / 100;\nconst b = (x + y) / n;\nconst c = `${a / b}`;")).toEqual([1, 2, 3]);
    const clean = [
      "// paid / due",
      "/* a / b */",
      'const href = "/debtors/" + id;',
      "const u = `/debtors/${id}`;",
      "const r = /^\\d+$/.test(s);",
      "const j = <a href={u}>x</a>;",
      "const k = <br />;",
      'const url = "https://example.com/x"; // see a / b',
    ].join("\n");
    expect(findDivisions(clean)).toEqual([]);
  });

  it("treats a missing directory as empty", () => {
    expect(listSourceFiles(join(WEB_ROOT, "components/does-not-exist"))).toEqual([]);
  });
});

describe("graveyard and crew sources contain no float money handling", () => {
  it("has no toFixed, parseFloat or Number( in lib/graveyard, components/graveyard, app/api/crew or lib/crew", () => {
    const report: string[] = [];
    for (const file of SCANNED_DIRS.flatMap(listSourceFiles)) {
      for (const { line, token } of findOffences(readFileSync(file, "utf8"))) {
        report.push(`${relative(WEB_ROOT, file)}:${line} uses ${token}`);
      }
    }
    expect(report, `Banned money tokens found:\n${report.join("\n")}`).toEqual([]);
  });
});

describe("rupee sign detector", () => {
  it("flags a ₹ sign, except in the Pricing_File", () => {
    const source = 'const a = "₹1";';
    expect(findRupeeSigns("lib/landing/copy.ts", source)).toEqual([1]);
    expect(findRupeeSigns("lib/landing/pricing.ts", source)).toEqual([]);
  });
});

describe("landing sources contain no hand-typed money", () => {
  // Tests live in apps/web/test, but skip any co-located test file too.
  const files = LANDING_DIRS.flatMap(listSourceFiles).filter((f) => !/\.test\.tsx?$/.test(f));
  const rel = (file: string) => relative(WEB_ROOT, file);

  it("scans the landing directories, so the check is not vacuous", () => {
    expect(files.map(rel)).toContain("app/(site)/landing/page.tsx");
    expect(files.map(rel)).toContain("lib/landing/pricing.ts");
  });

  it("has no toFixed, parseFloat or Number( in app/(site)/landing or lib/landing", () => {
    const report: string[] = [];
    for (const file of files) {
      for (const { line, token } of findOffences(readFileSync(file, "utf8"))) {
        report.push(`${rel(file)}:${line} uses ${token}`);
      }
    }
    expect(report, `Banned money tokens found:\n${report.join("\n")}`).toEqual([]);
  });

  it("has no division operator in app/(site)/landing or lib/landing", () => {
    const report = files.flatMap((file) => findDivisions(readFileSync(file, "utf8")).map((line) => `${rel(file)}:${line}`));
    expect(report, `Division found:\n${report.join("\n")}`).toEqual([]);
  });

  it("has no ₹ sign outside lib/landing/pricing.ts", () => {
    const report = files.flatMap((file) => findRupeeSigns(rel(file), readFileSync(file, "utf8")).map((line) => `${rel(file)}:${line}`));
    expect(report, `₹ sign found:\n${report.join("\n")}`).toEqual([]);
  });
});

describe("debtor sources contain no float money handling", () => {
  const files = DEBTOR_DIRS.flatMap(listSourceFiles);

  it("scans the debtor directories, so the check is not vacuous", () => {
    const names = files.map((f) => relative(WEB_ROOT, f));
    expect(names).toContain("lib/debtor/candle-timeline.ts");
    expect(names).toContain("lib/debtor/build-debtor-view.ts");
    expect(names.some((n) => n.startsWith("components/debtor/"))).toBe(true);
    expect(names.some((n) => n.startsWith("app/(debtor)/"))).toBe(true);
  });

  it("has no toFixed, parseFloat or Number( in lib/debtor, components/debtor or app/(debtor)", () => {
    const report: string[] = [];
    for (const file of files) {
      for (const { line, token } of findOffences(readFileSync(file, "utf8"))) {
        report.push(`${relative(WEB_ROOT, file)}:${line} uses ${token}`);
      }
    }
    expect(report, `Banned money tokens found:\n${report.join("\n")}`).toEqual([]);
  });

  it("has no division operator in lib/debtor, components/debtor or app/(debtor)", () => {
    const report = files.flatMap((file) => findDivisions(readFileSync(file, "utf8")).map((line) => `${relative(WEB_ROOT, file)}:${line}`));
    expect(report, `Division found:\n${report.join("\n")}`).toEqual([]);
  });
});
