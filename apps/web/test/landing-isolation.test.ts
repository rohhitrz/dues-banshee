// Node types are needed for node:fs and fileURLToPath.
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Feature: landing-3d, review fix: the public landing page reads no env, request data, network or database.
// It renders the same output for every visitor, so a build-time failure is the only failure mode.

interface Offence {
  line: number;
  token: string;
}

const FORBIDDEN: readonly { token: string; pattern: RegExp }[] = [
  { token: "process.env", pattern: /\bprocess\.env\b/ },
  { token: "cookies(", pattern: /\bcookies\s*\(/ },
  { token: "headers(", pattern: /\bheaders\s*\(/ },
  { token: "searchParams", pattern: /\bsearchParams\b/ },
  { token: "fetch(", pattern: /\bfetch\s*\(/ },
  { token: "createDb", pattern: /\bcreateDb\b/ },
];

/** Returns every forbidden-token occurrence in `source` with its 1-based line number. */
function findRequestDependence(source: string): Offence[] {
  const offences: Offence[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    for (const { token, pattern } of FORBIDDEN) {
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
const LANDING_DIRS = ["app/(site)/landing", "lib/landing"].map((d) => join(WEB_ROOT, d));

describe("request-dependence detector", () => {
  it("detects each forbidden token with its line number", () => {
    const source = [
      "const a = 1;",
      "const k = process.env.SECRET;",
      "const c = cookies();",
      "const h = await headers();",
      "const q = props.searchParams;",
      "const r = await fetch(url);",
      "const d = createDb();",
    ].join("\n");
    expect(findRequestDependence(source)).toEqual([
      { line: 2, token: "process.env" },
      { line: 3, token: "cookies(" },
      { line: 4, token: "headers(" },
      { line: 5, token: "searchParams" },
      { line: 6, token: "fetch(" },
      { line: 7, token: "createDb" },
    ]);
  });

  it("reports nothing for static code", () => {
    expect(findRequestDependence("const n = sharmaExample();\nconst cookie = 'x';\nconst prefetched = 1;\n")).toEqual([]);
  });
});

describe("landing sources do not depend on the request", () => {
  // Tests live in apps/web/test, but skip any co-located test file too.
  const files = LANDING_DIRS.flatMap(listSourceFiles).filter((f) => !/\.test\.tsx?$/.test(f));
  const rel = (file: string) => relative(WEB_ROOT, file);

  it("scans the landing directories, so the check is not vacuous", () => {
    expect(files.map(rel)).toContain("app/(site)/landing/page.tsx");
    expect(files.map(rel)).toContain("lib/landing/sharma-example.ts");
  });

  it("has no process.env, cookies(, headers(, searchParams, fetch( or createDb in app/(site)/landing or lib/landing", () => {
    const report: string[] = [];
    for (const file of files) {
      for (const { line, token } of findRequestDependence(readFileSync(file, "utf8"))) {
        report.push(`${rel(file)}:${line} uses ${token}`);
      }
    }
    expect(report, `Request-dependent code found:\n${report.join("\n")}`).toEqual([]);
  });
});
