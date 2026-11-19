// Node types are needed for node:fs and fileURLToPath.
/// <reference types="node" />
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Feature: buyer-voice-call, Reqs 3.3, 3.6, 3.8, 3.9, 10.1, 11.11: model IDs live in models.ts only,
// no @openai/agents dependency, and OPENAI_API_KEY is read on the server only.

// apps/web/test -> repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The one file that may name a Realtime_Model, Transcribe_Model or Banned_Model_ID (Req 3.7, 3.8). */
const MODELS_FILE = "packages/agent/src/models.ts";

/** Build output and dependency folders: never scanned. */
const BUILD_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo", ".vercel", ".git", "test-results"]);
/** Folders that hold tests only. */
const TEST_DIRS = new Set(["test", "tests", "__tests__", "e2e"]);

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/;

/** Repo-relative, forward-slash paths of every non-test .ts/.tsx/.js/.mjs file under `dir`. */
function listSources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!BUILD_DIRS.has(entry) && !TEST_DIRS.has(entry)) files.push(...listSources(full));
    } else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry) && !entry.endsWith(".d.ts")) {
      files.push(relative(REPO_ROOT, full).split(sep).join("/"));
    }
  }
  return files.sort();
}

/** Every package.json under `dir`, excluding dependency and build folders. */
function listPackageJsons(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!BUILD_DIRS.has(entry)) files.push(...listPackageJsons(full));
    } else if (entry === "package.json") {
      files.push(relative(REPO_ROOT, full).split(sep).join("/"));
    }
  }
  return files.sort();
}

const read = (repoPath: string) => readFileSync(join(REPO_ROOT, repoPath), "utf8");

const ALL_SOURCES = ["apps", "packages"].flatMap((d) => listSources(join(REPO_ROOT, d)));

// --- model IDs (Req 3.7, 3.8) ---------------------------------------------------------------------------------

/**
 * Realtime_Model and Transcribe_Model IDs (`gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-live-transcribe`),
 * matched as the `gpt-realtime` / `gpt-live-transcribe` family so a renamed variant cannot slip in.
 */
const VOICE_MODEL_ID = /(?<![\w-])(?:gpt-realtime(?:-[\w.]+)*|gpt-live-transcribe)(?![\w-])/g;
/** Banned_Model_IDs. A longer name that merely starts with one of them (`tts-1-hd-x`, `whisper-10`) is not a match. */
const BANNED_MODEL_ID = /(?<![\w-])(?:gpt-4o-transcribe|whisper-1|tts-1-hd|tts-1|gpt-4o-mini-tts)(?![\w.-])/g;

/** Model IDs named in `source`, in order of appearance. */
function findModelIds(source: string): string[] {
  return [...source.matchAll(VOICE_MODEL_ID), ...source.matchAll(BANNED_MODEL_ID)]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((m) => m[0]);
}

describe("model ID scanner", () => {
  it("finds the voice model IDs and every banned ID", () => {
    const source = [
      'const a = "gpt-realtime-2.1";',
      'const b = "gpt-realtime-2.1-mini";',
      'const c = "gpt-live-transcribe";',
      'const d = "gpt-4o-transcribe";',
      'const e = "whisper-1";',
      'const f = "tts-1";',
      'const g = "tts-1-hd";',
      'const h = "gpt-4o-mini-tts";',
    ].join("\n");
    expect(findModelIds(source)).toEqual([
      "gpt-realtime-2.1",
      "gpt-realtime-2.1-mini",
      "gpt-live-transcribe",
      "gpt-4o-transcribe",
      "whisper-1",
      "tts-1",
      "tts-1-hd",
      "gpt-4o-mini-tts",
    ]);
  });

  it("reports tts-1-hd once, not also as tts-1", () => {
    expect(findModelIds('model: "tts-1-hd"')).toEqual(["tts-1-hd"]);
  });

  it("ignores unrelated strings that only look similar", () => {
    const clean = [
      'const a = "not-tts-1-model";',
      'const b = "whisper-10";',
      'const c = "gpt-live-transcribed";',
      'const d = "bgpt-realtime-2.1";',
      'const e = "https://example.com/tts-1.mp3";',
      'const f = "gpt-4o-transcribe-x";',
      'const g = "gpt-live";',
      "const h = VOICE_MODEL_IDS.realtime;",
    ].join("\n");
    expect(findModelIds(clean)).toEqual([]);
  });
});

describe("voice model IDs live in models.ts only (Req 3.7, 3.8, 11.11)", () => {
  it("scans the real source files, so the check is not vacuous", () => {
    expect(ALL_SOURCES.length).toBeGreaterThan(50);
    expect(ALL_SOURCES).toContain(MODELS_FILE);
    expect(ALL_SOURCES).toContain("packages/voice/src/openai-realtime.ts");
    expect(ALL_SOURCES).toContain("apps/web/app/api/voice/session/route.ts");
    // Tests, build output and dependencies are outside the scan.
    expect(ALL_SOURCES.filter((f) => /(^|\/)(test|node_modules|\.next|dist|coverage|\.turbo)\//.test(f) || TEST_FILE.test(f))).toEqual([]);
  });

  it("names the Realtime_Model, the Transcribe_Model and each Banned_Model_ID only as allowed in models.ts", () => {
    const models = read(MODELS_FILE);
    expect(findModelIds(models)).toEqual(expect.arrayContaining(["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-live-transcribe"]));
    expect(models.match(BANNED_MODEL_ID)).toBeNull();
  });

  it("has no Realtime_Model, Transcribe_Model or Banned_Model_ID in any other non-test source file", () => {
    const report: string[] = [];
    for (const file of ALL_SOURCES) {
      if (file === MODELS_FILE) continue;
      for (const id of new Set(findModelIds(read(file)))) report.push(`${file} names ${id}`);
    }
    expect(report, `Model IDs outside models.ts:\n${report.join("\n")}`).toEqual([]);
  });
});

// --- @openai/agents (Req 3.9) ----------------------------------------------------------------------------------

describe("no package.json lists @openai/agents (Req 3.9, 11.11)", () => {
  const manifests = ["package.json", ...["apps", "packages"].flatMap((d) => listPackageJsons(join(REPO_ROOT, d)))];

  it("checks the root, apps/web and every package manifest", () => {
    expect(manifests).toEqual(
      expect.arrayContaining(["package.json", "apps/web/package.json", "packages/agent/package.json", "packages/voice/package.json"]),
    );
  });

  it("finds no @openai/agents entry in any manifest", () => {
    // Raw text on purpose: a dependency, an override and a nested field are all caught the same way.
    const offenders = manifests.filter((file) => /@openai\/agents/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});

// --- OPENAI_API_KEY (Req 3.3, 10.1) ----------------------------------------------------------------------------

/**
 * Removes block and line comments in one pass. String and template literals are matched first and kept, so a
 * `//` in a URL or a `/**` inside a line comment cannot open a bogus comment that swallows real code.
 */
function stripComments(source: string): string {
  return source.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (_m, str: string | undefined) => str ?? "",
  );
}

/** True when `source` names the variable in code, as opposed to prose in a comment. */
function readsOpenAiKey(source: string): boolean {
  return /\bOPENAI_API_KEY\b/.test(stripComments(source));
}

/** True when the file starts with the given directive, after any comments and blank lines. */
function hasDirective(source: string, directive: "use client" | "use server"): boolean {
  return new RegExp(`^(?:\\s|//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*["']${directive}["']`).test(source);
}

/** Files that run in the browser: never allowed to name the key. */
function isClientFile(file: string, source: string): boolean {
  return (
    hasDirective(source, "use client") ||
    file.endsWith("/call-client.tsx") ||
    file.startsWith("apps/web/lib/call/") ||
    file.startsWith("apps/web/components/") ||
    file.startsWith("apps/web/app/(call)/")
  );
}

/** Server files: packages, route handlers, server actions and the `apps/web/lib` loaders that only run on the server. */
function isServerFile(file: string, source: string): boolean {
  if (isClientFile(file, source)) return false;
  return file.startsWith("packages/") || file.startsWith("apps/web/app/api/") || hasDirective(source, "use server") || file.startsWith("apps/web/lib/");
}

describe("OPENAI_API_KEY scanner", () => {
  it("ignores comments and finds code reads", () => {
    expect(readsOpenAiKey("// OPENAI_API_KEY is set\nconst a = 1;")).toBe(false);
    expect(readsOpenAiKey("/** `OPENAI_API_KEY` is set and not empty. */ const a = 1;")).toBe(false);
    expect(readsOpenAiKey("const k = process.env.OPENAI_API_KEY ?? '';")).toBe(true);
    expect(readsOpenAiKey('const k = env["OPENAI_API_KEY"];')).toBe(true);
    expect(readsOpenAiKey("const k = process.env.MY_OPENAI_API_KEY_2;")).toBe(false);
  });

  it("is not fooled by a block-comment opener inside a line comment or a URL in a string", () => {
    expect(readsOpenAiKey("// globs: test/** only\nconst k = process.env.OPENAI_API_KEY;\n/** doc */")).toBe(true);
    expect(readsOpenAiKey('const u = "https://x.test/a"; const k = env.OPENAI_API_KEY;')).toBe(true);
  });

  it("flags a sample client file that uses the key", () => {
    const sample = '"use client";\nexport const key = process.env.OPENAI_API_KEY;\n';
    expect(isClientFile("apps/web/app/(app)/sample.tsx", sample) && readsOpenAiKey(sample)).toBe(true);
    // The same code under components/ or app/(call)/ is flagged without the directive.
    const plain = "export const key = process.env.OPENAI_API_KEY;\n";
    expect(isClientFile("apps/web/components/x.tsx", plain) && readsOpenAiKey(plain)).toBe(true);
    expect(isClientFile("apps/web/app/(call)/call/[token]/x.ts", plain) && readsOpenAiKey(plain)).toBe(true);
    // A server file with the same code is not flagged.
    expect(isClientFile("apps/web/app/api/voice/session/route.ts", plain)).toBe(false);
  });

  it("recognizes directives after comments and not inside code", () => {
    expect(hasDirective('"use client";\nconst a = 1;', "use client")).toBe(true);
    expect(hasDirective("// c\n/* d */\n'use server';\n", "use server")).toBe(true);
    expect(hasDirective('const a = 1;\n"use client";', "use client")).toBe(false);
    expect(hasDirective('"use server";', "use client")).toBe(false);
  });

  it("classifies client and server files", () => {
    expect(isServerFile("apps/web/app/api/voice/session/route.ts", "export {};")).toBe(true);
    expect(isServerFile("apps/web/app/(debtor)/debtors/[id]/call-actions.ts", '"use server";')).toBe(true);
    expect(isServerFile("packages/voice/src/handlers.ts", "export {};")).toBe(true);
    expect(isServerFile("apps/web/app/(call)/call/[token]/call-client.tsx", '"use client";')).toBe(false);
    expect(isServerFile("apps/web/lib/call/call-session.ts", "export {};")).toBe(false);
    expect(isServerFile("apps/web/components/debtor/start-call-controls.tsx", "export {};")).toBe(false);
    expect(isServerFile("apps/web/app/(call)/call/[token]/page.tsx", "export {};")).toBe(false);
    expect(isServerFile("apps/web/app/(app)/page.tsx", "export {};")).toBe(false);
    expect(isServerFile("apps/web/next.config.ts", "export {};")).toBe(false);
  });
});

describe("OPENAI_API_KEY is read only in server files (Req 3.3, 10.1, 11.11)", () => {
  const readers = ALL_SOURCES.filter((file) => readsOpenAiKey(read(file)));

  it("finds the known server readers, so the check is not vacuous", () => {
    expect(readers).toContain("apps/web/app/api/voice/session/route.ts");
    expect(readers).toContain("apps/web/app/(debtor)/debtors/[id]/call-actions.ts");
    expect(readers).toContain("apps/web/lib/debtor/build-start-call-controls.ts");
    expect(readers).toContain("packages/agent/scripts/live-check.ts");
  });

  it("is never named in a client file, call-client.tsx or apps/web/lib/call/*", () => {
    const offenders = ALL_SOURCES.filter((file) => isClientFile(file, read(file)) && readsOpenAiKey(read(file)));
    expect(offenders).toEqual([]);
  });

  it("is named only in server files", () => {
    const offenders = readers.filter((file) => !isServerFile(file, read(file)));
    expect(offenders, `Not server files:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("is in no NEXT_PUBLIC_ variable, and neither is VOICE_REALTIME_MODEL", () => {
    const publicKey = /NEXT_PUBLIC_[A-Z0-9_]*(?:OPENAI|VOICE_REALTIME)/;
    expect(publicKey.test("NEXT_PUBLIC_OPENAI_API_KEY=")).toBe(true);
    expect(publicKey.test("NEXT_PUBLIC_BASE_URL=")).toBe(false);

    const files = [...ALL_SOURCES, "apps/web/.env.example"];
    const offenders = files.filter((file) => publicKey.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("is not exposed through the `env` block of next.config", () => {
    const config = stripComments(read("apps/web/next.config.ts"));
    expect(/OPENAI_API_KEY|VOICE_REALTIME_MODEL/.test(config)).toBe(false);
  });
});
