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
const SCANNED_DIRS = ["lib/graveyard", "components/graveyard"].map((d) => join(WEB_ROOT, d));

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

  it("treats a missing directory as empty", () => {
    expect(listSourceFiles(join(WEB_ROOT, "components/does-not-exist"))).toEqual([]);
  });
});

describe("graveyard sources contain no float money handling", () => {
  it("has no toFixed, parseFloat or Number( in lib/graveyard or components/graveyard", () => {
    const report: string[] = [];
    for (const file of SCANNED_DIRS.flatMap(listSourceFiles)) {
      for (const { line, token } of findOffences(readFileSync(file, "utf8"))) {
        report.push(`${relative(WEB_ROOT, file)}:${line} uses ${token}`);
      }
    }
    expect(report, `Banned money tokens found:\n${report.join("\n")}`).toEqual([]);
  });
});
