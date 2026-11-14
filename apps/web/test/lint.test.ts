// Node types are needed for fileURLToPath; the ESLint Node API runs in the Vitest process.
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
  it.each(["next/server", "next", "next-auth", "next-auth/jwt", "next-auth/providers/credentials"])("passes %s in proxy.ts and auth.config.ts", async (spec) => {
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
  // Path traversal through an allowed package prefix would reach auth.ts or db code.
  it.each([
    "next/../../auth",
    "next-auth/../../lib/db",
    "next/./../auth",
    "next/..",
    "next/.",
    "next/server/../../../auth",
    "next/",
    "next//server",
    "next\\server",
    "next-auth/..\\..\\auth",
  ])("fails the traversal specifier %s in proxy.ts and auth.config.ts", async (spec) => {
    const code = `import * as m from ${JSON.stringify(spec)};\nexport const v = m;\n`;
    expect(ids(await lintText(code, "apps/web/proxy.ts"))).toEqual([[2, RULE]]);
    expect(ids(await lintText(code, "apps/web/auth.config.ts"))).toEqual([[2, RULE]]);
  });
  it("passes dotted names that are not . or .. segments", async () => {
    const code = 'import * as m from "next/..hidden/a.b";\nexport const v = m;\n';
    expect(await lintText(code, "apps/web/proxy.ts")).toEqual([]);
  });
  it.each([
    ["module.require", 'const m = module.require("./auth");\nexport const v = m;'],
    ["an aliased module.require", 'const r = module.require;\nexport const v = r;'],
    ["createRequire", 'export const v = createRequire(import.meta.url)("./auth");'],
    ["module.createRequire", 'export const v = module.createRequire(import.meta.url);'],
    ["require.resolve", 'export const v = require.resolve("./auth");'],
  ])("fails %s in proxy.ts and auth.config.ts", async (_name, code) => {
    for (const file of ["apps/web/proxy.ts", "apps/web/auth.config.ts"]) {
      const messages = (await lintText(`${code}\n`, file)).filter((m) => m.ruleId === RULE);
      expect(ids(messages)).toEqual([[2, RULE]]);
    }
  });
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

// Feature: debtor-ui, Req 6.3: the only active-promise rule is the Engine's hasActivePromise / activePromiseUntil.
/** True when `source` compares a `promise` event kind with `promisedDate`, i.e. re-implements the wisp rule. */
function hasInlinePromiseCheck(source: string): boolean {
  return (
    /kind\s*[!=]==?\s*["']promise["'][^;]{0,120}promisedDate/.test(source) ||
    /promisedDate[^;]{0,120}kind\s*[!=]==?\s*["']promise["']/.test(source) ||
    /["']promise["']\s*[!=]==?\s*[\w.]*kind[^;]{0,120}promisedDate/.test(source)
  );
}

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIPPED_DIRS = new Set(["node_modules", ".next", "test", "e2e", "coverage"]);

/** Every non-test .ts/.tsx source file under `dir`. */
function listWebSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS.has(entry)) files.push(...listWebSources(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) {
      files.push(full);
    }
  }
  return files.sort();
}

describe("apps/web active-promise scan", () => {
  it("detects an inline promise check in each common spelling", () => {
    expect(hasInlinePromiseCheck('history.some((e) => e.kind === "promise" && e.promisedDate >= today)')).toBe(true);
    expect(hasInlinePromiseCheck("history.filter(e => e.promisedDate >= t && e.kind === 'promise')")).toBe(true);
    expect(hasInlinePromiseCheck('const x = "promise" === e.kind && e.promisedDate >= today;')).toBe(true);
    expect(hasInlinePromiseCheck('if (e.kind !== "promise") continue;\nconst d = e.promisedDate;')).toBe(false);
  });

  it("allows calls to hasActivePromise and activePromiseUntil", () => {
    expect(hasInlinePromiseCheck("wisp: !paid && hasActivePromise(history, today)")).toBe(false);
    expect(hasInlinePromiseCheck("const until = activePromiseUntil(history, today);")).toBe(false);
  });

  it("finds no inline active-promise check in any apps/web source outside tests", () => {
    const sources = listWebSources(WEB_ROOT);
    expect(sources.length).toBeGreaterThan(0);
    const offenders = sources
      .filter((file) => hasInlinePromiseCheck(readFileSync(file, "utf8")))
      .map((file) => file.slice(WEB_ROOT.length));
    expect(offenders).toEqual([]);
  });
});

// Feature: debtor-ui, Reqs 4.5, 5.5, 5.8, 6.3, 9.1: source scans over the debtor screen.
const DEBTOR_DIRS = ["lib/debtor", "components/debtor", "app/(debtor)"].map((d) => join(WEB_ROOT, d));

/** Removes block and line comments (a `//` right after `:` is a URL, not a comment). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** True when `source` imports or renders a canvas, three.js or WebGL. */
function usesCanvasOrWebGl(source: string): boolean {
  const code = stripComments(source);
  return /<canvas\b|OffscreenCanvas|webgl|["']three(\/[^"']*)?["']|["']@react-three\//i.test(code);
}

/** Names of `@keyframes` blocks that are not nested in `@media (prefers-reduced-motion: no-preference)`. */
function findUnguardedKeyframes(css: string): string[] {
  const code = stripComments(css);
  const guard = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/;
  const stack: string[] = [];
  const offenders: string[] = [];
  let prelude = "";
  for (const ch of code) {
    if (ch === "{") {
      const head = prelude.trim();
      const keyframes = /^@(?:-\w+-)?keyframes\s+(\S+)/.exec(head);
      if (keyframes !== null && !stack.some((h) => guard.test(h))) offenders.push(keyframes[1] ?? head);
      stack.push(head);
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else if (ch === ";") {
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  return offenders;
}

/** True when ACTION_TEXT is declared with `satisfies Record<EscalationAction, string>`. */
function actionTextIsExhaustive(source: string): boolean {
  return /export\s+const\s+ACTION_TEXT\s*=\s*\{[^}]*\}\s*(?:as\s+const\s+)?satisfies\s+Record<\s*EscalationAction\s*,\s*string\s*>/.test(
    stripComments(source),
  );
}

function listFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listFiles(full, pattern));
    else if (pattern.test(entry)) files.push(full);
  }
  return files.sort();
}

describe("debtor screen source scans", () => {
  const debtorSources = DEBTOR_DIRS.flatMap(listWebSources);
  const debtorCss = DEBTOR_DIRS.flatMap((dir) => listFiles(dir, /\.css$/));
  const rel = (file: string) => file.slice(WEB_ROOT.length);

  it("finds the debtor source and CSS files, so the scans below are not vacuous", () => {
    const names = debtorSources.map(rel);
    expect(names).toContain("lib/debtor/candle-timeline.ts");
    expect(names).toContain("lib/debtor/build-debtor-view.ts");
    expect(names.some((n) => n.startsWith("components/debtor/"))).toBe(true);
    expect(names.some((n) => n.startsWith("app/(debtor)/"))).toBe(true);
    expect(debtorCss.map(rel)).toContain("components/debtor/candle-timeline.module.css");
  });

  it("has no inline active-promise check in lib/debtor, components/debtor or app/(debtor)", () => {
    const offenders = debtorSources.filter((f) => hasInlinePromiseCheck(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("detects canvas, three.js and WebGL usage on sample strings", () => {
    expect(usesCanvasOrWebGl("<canvas ref={r} />")).toBe(true);
    expect(usesCanvasOrWebGl('import * as THREE from "three";')).toBe(true);
    expect(usesCanvasOrWebGl('import { Canvas } from "@react-three/fiber";')).toBe(true);
    expect(usesCanvasOrWebGl('el.getContext("webgl2")')).toBe(true);
    expect(usesCanvasOrWebGl("// no canvas or WebGL here\nconst a = 1;")).toBe(false);
    expect(usesCanvasOrWebGl("/* three.js, WebGL */ const a = 1;")).toBe(false);
  });

  it("uses no <canvas>, three.js or WebGL in the debtor sources or CSS", () => {
    const files = [...debtorSources, ...debtorCss];
    const offenders = files.filter((f) => usesCanvasOrWebGl(readFileSync(f, "utf8"))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("flags a @keyframes block that is not inside prefers-reduced-motion: no-preference", () => {
    const bare = "@keyframes flicker { 0% { opacity: 1; } }";
    expect(findUnguardedKeyframes(bare)).toEqual(["flicker"]);
    const wrongMedia = "@media (prefers-reduced-motion: reduce) { @keyframes flicker { 0% { opacity: 1; } } }";
    expect(findUnguardedKeyframes(wrongMedia)).toEqual(["flicker"]);
    const afterGuard = "@media (prefers-reduced-motion: no-preference) { .a { color: red; } }\n@keyframes late { 0% { opacity: 1; } }";
    expect(findUnguardedKeyframes(afterGuard)).toEqual(["late"]);
    const guarded = "@media (prefers-reduced-motion: no-preference) {\n  @keyframes flicker { 0% { opacity: 1; } }\n}";
    expect(findUnguardedKeyframes(guarded)).toEqual([]);
    expect(findUnguardedKeyframes("/* @keyframes x { } */ .a { color: red; }")).toEqual([]);
  });

  it("declares debtor flicker keyframes only inside prefers-reduced-motion: no-preference", () => {
    const report = debtorCss.flatMap((f) => findUnguardedKeyframes(readFileSync(f, "utf8")).map((name) => `${rel(f)}: ${name}`));
    expect(report).toEqual([]);
    // The candle timeline does declare keyframes, so the scan above has something to guard.
    const timeline = readFileSync(join(WEB_ROOT, "components/debtor/candle-timeline.module.css"), "utf8");
    expect(/@keyframes\b/.test(stripComments(timeline))).toBe(true);
  });

  it("detects a missing satisfies on ACTION_TEXT", () => {
    const good = 'export const ACTION_TEXT = { drafted: "drafted" } as const satisfies Record<EscalationAction, string>;';
    expect(actionTextIsExhaustive(good)).toBe(true);
    expect(actionTextIsExhaustive('export const ACTION_TEXT = { drafted: "drafted" } as const;')).toBe(false);
    expect(actionTextIsExhaustive('export const ACTION_TEXT: Record<string, string> = { drafted: "drafted" };')).toBe(false);
    expect(actionTextIsExhaustive("export const ACTION_TEXT = { a: 'a' } satisfies Record<string, string>;")).toBe(false);
  });

  it("types ACTION_TEXT in lib/debtor/candle-timeline.ts with satisfies Record<EscalationAction, string>", () => {
    expect(actionTextIsExhaustive(readFileSync(join(WEB_ROOT, "lib/debtor/candle-timeline.ts"), "utf8"))).toBe(true);
  });
});
