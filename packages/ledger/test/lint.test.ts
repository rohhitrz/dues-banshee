// The package tsconfig sets `types: []` to keep Node globals out of src. This test file alone needs Node types.
/// <reference types="node" />
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// packages/ledger/test -> repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// One restricted construct per line, so each error can be tied to its own line.
// Exports and the `declare` keep `no-unused-vars` quiet, so only the purity rules fire.
const SNIPPET = [
  "declare const x: { toFixed(digits: number): string };", // line 1
  'export const p = parseFloat("1");', // line 2
  "export const a = 0.5;", // line 3
  "export const b = 1e3;", // line 4
  "export const f = x.toFixed(2);", // line 5
  "export const d = Date.now();", // line 6
  "export const r = Math.random();", // line 7
  "",
].join("\n");

const eslint = new ESLint({ cwd: REPO_ROOT });

async function lintText(text: string, filePath: string) {
  const [result] = await eslint.lintText(text, { filePath });
  if (result === undefined) throw new Error("ESLint returned no result");
  return result.messages;
}

function lint(filePath: string) {
  return lintText(SNIPPET, filePath);
}

describe("packages/ledger purity lint rules", () => {
  it("reports exactly one error for each of the six restricted constructs in src", async () => {
    const messages = await lint("packages/ledger/src/__lint_fixture__.ts");

    expect(messages.every((m) => m.severity === 2)).toBe(true);
    expect(messages.map((m) => [m.line, m.ruleId])).toEqual([
      [2, "no-restricted-globals"], // parseFloat
      [3, "no-restricted-syntax"], // 0.5
      [4, "no-restricted-syntax"], // 1e3
      [5, "no-restricted-properties"], // .toFixed
      [6, "no-restricted-globals"], // Date
      [7, "no-restricted-properties"], // Math.random
    ]);
  });

  it("names the offending construct in each message", async () => {
    const messages = await lint("packages/ledger/src/__lint_fixture__.ts");
    const byLine = new Map(messages.map((m) => [m.line, m.message]));

    expect(byLine.get(2)).toContain("parseFloat");
    expect(byLine.get(3)).toContain("no fractional or exponent literals");
    expect(byLine.get(4)).toContain("no fractional or exponent literals");
    expect(byLine.get(5)).toContain("toFixed");
    expect(byLine.get(6)).toContain("Date");
    expect(byLine.get(7)).toContain("Math.random");
  });

  it("does not apply the purity rules to files under test", async () => {
    const messages = await lint("packages/ledger/test/x.ts");

    const restricted = messages.filter((m) => m.ruleId?.startsWith("no-restricted-") ?? false);
    expect(restricted).toEqual([]);
  });
});

// Each construct is linted alone, so "exactly one error" means this construct and no other rule.
const BYPASS_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ["Number.parseFloat", 'export const v = Number.parseFloat("1");', "no-restricted-properties"],
  ["globalThis.parseFloat", 'export const v = globalThis.parseFloat("1");', "no-restricted-properties"],
  ["new globalThis.Date()", "export const v = new globalThis.Date();", "no-restricted-properties"],
  ["globalThis.Math.random()", "export const v = globalThis.Math.random();", "no-restricted-properties"],
  ["a trailing-point literal", "export const v = 1.;", "no-restricted-syntax"],
  ["process", "export const v = process;", "no-restricted-globals"],
  ["fetch", "export const v = fetch;", "no-restricted-globals"],
  ["setTimeout", "export const v = setTimeout;", "no-restricted-globals"],
  ["setInterval", "export const v = setInterval;", "no-restricted-globals"],
  ["performance", "export const v = performance;", "no-restricted-globals"],
  ['an import from "node:fs"', 'import * as fs from "node:fs";\nexport const v = fs;', "no-restricted-imports"],
];

describe("packages/ledger purity lint rules: bypasses", () => {
  it.each(BYPASS_CASES)("reports exactly one error for %s in src", async (_name, code, ruleId) => {
    const messages = await lintText(`${code}\n`, "packages/ledger/src/__lint_fixture__.ts");
    expect(messages.map((m) => [m.severity, m.ruleId])).toEqual([[2, ruleId]]);
  });

  it.each(BYPASS_CASES)("reports no restricted-rule error for %s under test", async (_name, code) => {
    const messages = await lintText(`${code}\n`, "packages/ledger/test/x.ts");
    expect(messages.filter((m) => m.ruleId?.startsWith("no-restricted-") ?? false)).toEqual([]);
  });
});

describe("packages/engine purity lint rules: globalThis bypasses", () => {
  it.each([
    ["new globalThis.Date()", "export const v = new globalThis.Date();"],
    ["globalThis.Math.random()", "export const v = globalThis.Math.random();"],
    ["globalThis.process", "export const v = globalThis.process;"],
    ["globalThis.parseFloat", 'export const v = globalThis.parseFloat("1");'],
  ])("reports exactly one error for %s in engine src", async (_name, code) => {
    const messages = await lintText(`${code}\n`, "packages/engine/src/__lint_fixture__.ts");
    expect(messages.map((m) => [m.severity, m.ruleId])).toEqual([[2, "no-restricted-properties"]]);
  });

  it.each([
    ["a trailing-point literal", "export const v = 1.;"],
    ["a trailing-point literal with an exponent", "export const v = 1.e3;"],
  ])("reports exactly one error for %s in engine src", async (_name, code) => {
    const messages = await lintText(`${code}\n`, "packages/engine/src/__lint_fixture__.ts");
    expect(messages.map((m) => [m.severity, m.ruleId])).toEqual([[2, "no-restricted-syntax"]]);
  });

  it.each([
    ["a fractional literal", "export const v = 0.5;"],
    ["an integer literal", "export const v = 1;"],
    ["a bare parseFloat", 'export const v = parseFloat("1");'],
  ])("still allows %s in engine src", async (_name, code) => {
    const messages = await lintText(`${code}\n`, "packages/engine/src/__lint_fixture__.ts");
    expect(messages).toEqual([]);
  });
});
