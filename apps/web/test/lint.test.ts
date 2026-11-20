// Node types are needed for fileURLToPath; the ESLint Node API runs in the Vitest process.
/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
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

// Feature: whatsapp-channel, Reqs 1.1, 8.1, 8.2, 8.3: provider hosts, env names, secrets and env files.

/** Provider hosts that only a `packages/agent` Message_Channel or Razorpay client may name (Req 1.1). */
const PROVIDER_HOSTS = /api\.twilio\.com|\bwa\.me\b|api\.razorpay\.com/;

/** True when the code (comments removed) of `source` names a provider host. */
function namesProviderHost(source: string): boolean {
  return PROVIDER_HOSTS.test(stripComments(source));
}

/** The Channel_Env names of Req 8.1, in `.env.example`. */
const CHANNEL_ENV_NAMES = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "TWILIO_SANDBOX_JOIN_CODE",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "PUBLIC_BASE_URL",
  "DEMO_BUYER_WHATSAPP",
] as const;

/** Names that `.env.example` lists with an empty value, one `NAME=` per line. */
function emptyEnvNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^([A-Z][A-Z0-9_]*)=$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** `+91` followed by ten digits, with an optional space or hyphen between (Req 8.3). */
const INDIAN_NUMBER = /\+91[ -]?[0-9]{10}(?![0-9])/g;
/** The only phone numbers that may appear in tracked files (Req 8.3), written without separators. */
const FICTIONAL_NUMBERS: ReadonlySet<string> = new Set(["+919000000001", "+919000000002", "+919000000099"]);

/** Descriptions of every secret-shaped value or real-looking phone number in `text`. */
function findSecretShapes(text: string): string[] {
  const found: string[] = [];
  if (/\bAC[0-9a-f]{32}\b/.test(text)) found.push("Twilio account SID");
  if (/\brzp_(?:test|live)_[A-Za-z0-9]{14}/.test(text)) found.push("Razorpay key id");
  for (const match of text.matchAll(INDIAN_NUMBER)) {
    if (!FICTIONAL_NUMBERS.has(match[0].replace(/[ -]/g, ""))) found.push("phone number");
  }
  return found;
}

/** Repo-relative paths of every git-tracked file. */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((p) => p !== "");
}

/** True when git ignores `relativePath` (it need not exist). */
function isGitIgnored(relativePath: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", "--", relativePath], { cwd: REPO_ROOT }).status === 0;
}

/** Repo-relative paths of every local env file (`.env`, `.env.*`) outside dependency and build folders. */
function listEnvFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const rel = prefix === "" ? entry : `${prefix}/${entry}`;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!["node_modules", ".git", ".next", ".turbo", ".vercel", "dist", "coverage"].includes(entry)) files.push(...listEnvFiles(full, rel));
    } else if (entry === ".env" || entry.startsWith(".env.")) {
      files.push(rel);
    }
  }
  return files.sort();
}

describe("whatsapp-channel provider hosts (Req 1.1)", () => {
  it("detects each provider host in code but not in a comment", () => {
    expect(namesProviderHost('fetch("https://api.twilio.com/2010-04-01/x")')).toBe(true);
    expect(namesProviderHost('const u = "https://wa.me/?text=hi";')).toBe(true);
    expect(namesProviderHost("const u = `https://api.razorpay.com/v1/payment_links`;")).toBe(true);
    expect(namesProviderHost("// hands the owner a wa.me link\nconst a = 1;")).toBe(false);
    expect(namesProviderHost("/** Twilio at api.twilio.com */ const a = 1;")).toBe(false);
    expect(namesProviderHost('const swa = "dewa.mex";')).toBe(false);
  });

  it("names api.twilio.com, wa.me and api.razorpay.com in no apps/web source outside tests", () => {
    const sources = listWebSources(WEB_ROOT);
    expect(sources.length).toBeGreaterThan(0);
    const offenders = sources.filter((file) => namesProviderHost(readFileSync(file, "utf8"))).map((file) => file.slice(WEB_ROOT.length));
    expect(offenders).toEqual([]);
  });
});

describe("whatsapp-channel .env.example (Reqs 8.1, 8.2)", () => {
  const example = readFileSync(join(WEB_ROOT, ".env.example"), "utf8");

  it("lists every Channel_Env name with an empty value", () => {
    const names = emptyEnvNames(example);
    for (const name of CHANNEL_ENV_NAMES) expect(names).toContain(name);
  });

  it("keeps the existing entries and gives no entry a value", () => {
    const names = emptyEnvNames(example);
    for (const name of ["DATABASE_URL", "AUTH_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "LADDER_RUN_SECRET"]) expect(names).toContain(name);
    const assigned = example.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
    expect(assigned.filter((line) => !/^[A-Z][A-Z0-9_]*=$/.test(line))).toEqual([]);
  });

  it("detects a non-empty or misspelled entry", () => {
    expect(emptyEnvNames("TWILIO_AUTH_TOKEN=\nPUBLIC_BASE_URL=https://x.example\nTWILIO_AUTH_TOKEN =\n")).toEqual(["TWILIO_AUTH_TOKEN"]);
  });

  // Feature: crew-api, Req 6.3: the crew route's secret is listed with an empty value.
  it("lists CREW_READ_SECRET with an empty value", () => {
    expect(emptyEnvNames(example)).toContain("CREW_READ_SECRET");
  });
});

// Feature: crew-api, Req 5.2: the crew route and mapper must not import the agent or voice packages.

/** True when the code (comments removed) of `source` statically imports, dynamically imports or re-exports `@dues-banshee/agent` or `@dues-banshee/voice`, with or without a subpath. */
function importsAgentOrVoice(source: string): boolean {
  return /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]@dues-banshee\/(?:agent|voice)(?:\/[^"'`]*)?["'`]/.test(stripComments(source));
}

const CREW_DIRS = ["app/api/crew", "lib/crew"].map((d) => join(WEB_ROOT, d));

describe("crew-api agent and voice import scan (Req 5.2)", () => {
  it.each([
    ["a static import", 'import { draftStep } from "@dues-banshee/agent";'],
    ["a static import with a subpath", "import { x } from '@dues-banshee/agent/prompts';"],
    ["a type-only import", 'import type { T } from "@dues-banshee/voice";'],
    ["a side-effect import", 'import "@dues-banshee/voice";'],
    ["a multi-line import", 'import {\n  a,\n  b,\n} from\n  "@dues-banshee/voice/persona";'],
    ["a dynamic import", 'const m = await import("@dues-banshee/agent");'],
    ["a dynamic import with a subpath", "const m = import('@dues-banshee/voice/dates');"],
    ["a named re-export", 'export { x } from "@dues-banshee/agent";'],
    ["an export-all", 'export * from "@dues-banshee/voice";'],
  ])("flags %s", (_name, code) => {
    expect(importsAgentOrVoice(code)).toBe(true);
  });

  it("does not flag the package name in a comment, an @dues-banshee/db import or a similar package", () => {
    expect(importsAgentOrVoice('// import { x } from "@dues-banshee/agent";\nconst a = 1;')).toBe(false);
    expect(importsAgentOrVoice('/* import("@dues-banshee/voice") */ const a = 1;')).toBe(false);
    expect(importsAgentOrVoice('import { findSupplierIdByUdyam } from "@dues-banshee/db";')).toBe(false);
    expect(importsAgentOrVoice('import { formatINR } from "@dues-banshee/engine";')).toBe(false);
    expect(importsAgentOrVoice('import { x } from "@dues-banshee/agentic";')).toBe(false);
  });

  it("imports @dues-banshee/agent or @dues-banshee/voice in no app/api/crew or lib/crew source", () => {
    const offenders = CREW_DIRS.flatMap(listWebSources)
      .filter((file) => importsAgentOrVoice(readFileSync(file, "utf8")))
      .map((file) => file.slice(WEB_ROOT.length));
    expect(offenders).toEqual([]);
  });
});

describe("whatsapp-channel secrets and phone numbers in tracked files (Reqs 8.2, 8.3)", () => {
  // Built from pieces so this file does not contain a secret-shaped literal itself.
  const SID = `AC${"0123456789abcdef".repeat(2)}`;
  const TEN = `${"98765"}${"43210"}`;
  const KEY = `rzp_${"test"}_${"AbCd1234EfGh56"}`;

  it("detects a Twilio SID, a Razorpay key id and a non-fictional +91 number", () => {
    expect(findSecretShapes(`sid ${SID}`)).toEqual(["Twilio account SID"]);
    expect(findSecretShapes(`key ${KEY}`)).toEqual(["Razorpay key id"]);
    expect(findSecretShapes(`key ${KEY.replace("test", "live")}`)).toEqual(["Razorpay key id"]);
    expect(findSecretShapes(`call +91 ${TEN}`)).toEqual(["phone number"]);
    expect(findSecretShapes(`call +91-${TEN}`)).toEqual(["phone number"]);
    expect(findSecretShapes(`call +91${TEN}`)).toEqual(["phone number"]);
  });

  it("allows only the fictional fixture numbers and ignores near misses", () => {
    expect(findSecretShapes("+919000000001 +919000000002 +919000000099 +91 9000000001")).toEqual([]);
    expect(findSecretShapes(`AC${"0".repeat(31)} x${SID}0 rzp_test_short`)).toEqual([]);
    expect(findSecretShapes("+91 12345")).toEqual([]);
  });

  it("finds no Twilio SID, Razorpay key id or real-looking +91 number in any git-tracked file", () => {
    const files = trackedFiles();
    expect(files).toContain("apps/web/.env.example");
    const offenders: string[] = [];
    for (const file of files) {
      const full = join(REPO_ROOT, file);
      if (!existsSync(full) || statSync(full).size > 2_000_000) continue;
      const bytes = readFileSync(full);
      if (bytes.includes(0)) continue; // binary
      for (const shape of new Set(findSecretShapes(bytes.toString("utf8")))) offenders.push(`${file}: ${shape}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("whatsapp-channel local env files (Req 8.2)", () => {
  it("git-ignores every local env file except apps/web/.env.example", () => {
    const envFiles = listEnvFiles(REPO_ROOT).filter((p) => p !== "apps/web/.env.example");
    expect(envFiles.filter((p) => !isGitIgnored(p))).toEqual([]);
  });

  it("git-ignores the usual local env names, whether or not the files exist, and tracks no env file but the example", () => {
    for (const name of [".env", ".env.local", ".env.production", "apps/web/.env", "apps/web/.env.local", "apps/web/.env.development.local"]) {
      expect(isGitIgnored(name), name).toBe(true);
    }
    expect(isGitIgnored("apps/web/.env.example")).toBe(false);
    expect(trackedFiles().filter((p) => /(^|\/)\.env(\.|$)/.test(p))).toEqual(["apps/web/.env.example"]);
  });
});
