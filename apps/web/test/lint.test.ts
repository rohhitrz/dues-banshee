// Node types are needed for fileURLToPath; the ESLint Node API runs in the Vitest process.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// apps/web/test -> repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const eslint = new ESLint({ cwd: REPO_ROOT });

async function lintText(text: string, filePath: string) {
  const [result] = await eslint.lintText(text, { filePath });
  if (result === undefined) throw new Error("ESLint returned no result");
  return result.messages;
}

function lintRealFile(relativePath: string) {
  const text = readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), "utf8");
  return lintText(text, relativePath);
}

const RULE = "no-restricted-syntax";
const ids = (messages: { severity: number; ruleId: string | null }[]) => messages.map((m) => [m.severity, m.ruleId]);

describe("apps/web proxy import allowlist", () => {
  it("reports the allowlist message for a proxy.ts snippet importing ./auth", async () => {
    const messages = await lintText('import { auth } from "./auth";\nexport const proxy = auth;\n', "apps/web/proxy.ts");
    expect(messages.map((m) => [m.line, m.severity, m.ruleId])).toEqual([[1, 2, RULE]]);
    expect(messages[0]?.message).toContain("may only import");
  });
  it("fails the @/ alias in proxy.ts", async () => {
    const code = 'import { handleImportRequest } from "@/lib/import/route-guard";\nexport const v = handleImportRequest;\n';
    expect(ids(await lintText(code, "apps/web/proxy.ts"))).toEqual([[2, RULE]]);
  });
  it("passes ./auth.config in proxy.ts", async () => {
    const code = 'import authConfig from "./auth.config";\nexport const v = authConfig;\n';
    expect(await lintText(code, "apps/web/proxy.ts")).toEqual([]);
  });
  it.each(["next/server", "next", "next-auth", "next-auth/jwt"])("passes %s in proxy.ts and auth.config.ts", async (spec) => {
    const code = `import * as m from "${spec}";\nexport const v = m;\n`;
    expect(await lintText(code, "apps/web/proxy.ts")).toEqual([]);
    expect(await lintText(code, "apps/web/auth.config.ts")).toEqual([]);
  });
  it.each(["@/auth", "@/lib/db", "./lib/db", "./other", "../web/auth", "@dues-banshee/db", "@dues-banshee/db/testing", "@dues-banshee/ledger", "exceljs", "nextjs", "next-authx", "./auth.config.ts"])(
    "fails %s in proxy.ts and auth.config.ts (except ./auth.config rules)",
    async (spec) => {
      const code = `import * as m from "${spec}";\nexport const v = m;\n`;
      expect(ids(await lintText(code, "apps/web/proxy.ts"))).toEqual([[2, RULE]]);
      expect(ids(await lintText(code, "apps/web/auth.config.ts"))).toEqual([[2, RULE]]);
    },
  );
  it("fails ./auth.config inside auth.config.ts", async () => {
    const messages = await lintText('import { authConfig } from "./auth.config";\nexport const v = authConfig;\n', "apps/web/auth.config.ts");
    expect(ids(messages)).toEqual([[2, RULE]]);
  });
  // Each construct is linted alone, so "exactly one error" means this construct and no other rule.
  it.each([
    ["a type-only import", 'import type { Db } from "@dues-banshee/db";\nexport type V = Db;'],
    ["an inline type import", 'import { type Db } from "./other";\nexport type V = Db;'],
    ["a side-effect import", 'import "./other";'],
    ["a re-export", 'export { x } from "./other";'],
    ["an export-all", 'export * from "@/lib/db";'],
    ["a require call", 'const m = require("./other");\nexport const v = m;'],
    ["an import-equals require", 'import m = require("./other");\nexport const v = m;'],
    ["an import type expression", 'export type V = import("./other").X;'],
    ["a dynamic import", 'export const v = import("next/server");'],
  ])("reports exactly one error in proxy.ts for %s", async (_name, code) => {
    // require forms also trip @typescript-eslint/no-require-imports; only our rule is asserted.
    const messages = (await lintText(`${code}\n`, "apps/web/proxy.ts")).filter((m) => m.ruleId === RULE);
    expect(ids(messages)).toEqual([[2, RULE]]);
  });
  it("reports a dynamic import in auth.config.ts too", async () => {
    const messages = await lintText('export const v = import("./auth");\n', "apps/web/auth.config.ts");
    expect(ids(messages)).toEqual([[2, RULE]]);
  });
  it("does not apply the ban to other files", async () => {
    const snippet = 'import { auth } from "./auth";\nexport const v = auth;\n';
    const messages = await lintText(snippet, "apps/web/lib/other.ts");

    expect(messages.filter((m) => m.ruleId === "no-restricted-imports")).toEqual([]);
  });

  it.each(["apps/web/proxy.ts", "apps/web/auth.config.ts"])("reports no errors for the real %s", async (file) => {
    expect(await lintRealFile(file)).toEqual([]);
  });
});
