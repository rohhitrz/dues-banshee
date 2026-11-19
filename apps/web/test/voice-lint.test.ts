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
/**
 * Banned_Model_IDs. A longer name that merely starts with one of them (`tts-1-hd-x`, `whisper-10`) is not a
 * match. A trailing `.` does not hide an ID: `whisper-1.` and `tts-1.x` are caught. The one exception, a file
 * name in a URL path, is `isUrlFileName`.
 */
const BANNED_MODEL_ID = /(?<![\w-])(?:gpt-4o-transcribe|whisper-1|tts-1-hd|tts-1|gpt-4o-mini-tts)(?![\w-])/g;

/** True for a banned-looking name that is a file in a URL path (`https://example.com/tts-1.mp3`), not a model ID. */
function isUrlFileName(source: string, match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  return source[start - 1] === "/" && /^\.[A-Za-z0-9]{2,4}(?![\w])/.test(source.slice(start + match[0].length));
}

/** Model IDs named in `source`, in order of appearance. */
function findModelIds(source: string): string[] {
  const banned = [...source.matchAll(BANNED_MODEL_ID)].filter((m) => !isUrlFileName(source, m));
  return [...source.matchAll(VOICE_MODEL_ID), ...banned]
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

  it("catches a banned ID followed by a dot, as at the end of a sentence or in a version", () => {
    expect(findModelIds("// do not use whisper-1.")).toEqual(["whisper-1"]);
    expect(findModelIds('const m = "tts-1.x";')).toEqual(["tts-1"]);
    expect(findModelIds("Never gpt-4o-transcribe. Or tts-1-hd.")).toEqual(["gpt-4o-transcribe", "tts-1-hd"]);
  });

  it("lets a file name in a URL path through, but not the same text outside a URL", () => {
    expect(findModelIds('const e = "https://example.com/tts-1.mp3";')).toEqual([]);
    expect(findModelIds('const e = "https://example.com/audio/whisper-1.wav";')).toEqual([]);
    expect(findModelIds('const e = "tts-1.mp3";')).toEqual(["tts-1"]);
    expect(findModelIds('const e = "https://example.com/tts-1";')).toEqual(["tts-1"]);
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

/**
 * Files under `apps/web/lib/call/` that the browser bundles. Listed by name, not by folder: `start-call.ts`,
 * `callable.ts` and `call-copy.ts` sit in the same folder but are not browser files by folder.
 */
const CLIENT_LIB_FILES = new Set(["apps/web/lib/call/call-session.ts", "apps/web/lib/call/realtime-events.ts"]);

/** Files that run in the browser: never allowed to name the key. */
function isClientFile(file: string, source: string): boolean {
  return (
    hasDirective(source, "use client") ||
    CLIENT_LIB_FILES.has(file) ||
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
    expect(isServerFile("apps/web/lib/call/realtime-events.ts", "export {};")).toBe(false);
    expect(isServerFile("apps/web/components/debtor/start-call-controls.tsx", "export {};")).toBe(false);
    expect(isServerFile("apps/web/app/(call)/call/[token]/page.tsx", "export {};")).toBe(false);
    expect(isServerFile("apps/web/app/(app)/page.tsx", "export {};")).toBe(false);
    // Not browser files by folder any more: the rest of lib/call/ is classified like the rest of lib/.
    for (const file of ["start-call.ts", "callable.ts", "call-copy.ts"]) {
      expect(isClientFile(`apps/web/lib/call/${file}`, "export {};")).toBe(false);
      expect(isServerFile(`apps/web/lib/call/${file}`, "export {};")).toBe(true);
    }
    expect(isClientFile("apps/web/lib/call/start-call.ts", '"use client";\nexport {};')).toBe(true);
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

  it("is never named in a client file (a \"use client\" file, call-session.ts, realtime-events.ts, components/, app/(call)/)", () => {
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

// --- browser files import no server code (design: Call_Client) --------------------------------------------------

/** The browser files that hold the call UI and the session. Listed by name: the check must not skip one by accident. */
const BROWSER_CALL_FILES = [
  "apps/web/lib/call/call-session.ts",
  "apps/web/lib/call/realtime-events.ts",
  "apps/web/app/(call)/call/[token]/call-client.tsx",
  "apps/web/components/debtor/start-call-controls.tsx",
];

/** Value imports these files may make. The server action file is "use server": the browser gets a reference only. */
const ALLOWED_VALUE_IMPORTS = new Set([
  "react",
  "./realtime-events",
  "@/lib/call/call-session",
  "@/lib/call/call-copy",
  "@/app/(debtor)/debtors/[id]/call-actions",
]);

interface ImportRef {
  specifier: string;
  /** `import type …` or `export type … from`: erased at build time. `import { type X }` is not. */
  typeOnly: boolean;
}

/** Static imports, `export … from` and dynamic `import("…")` in `source`, comments removed. */
function findImports(source: string): ImportRef[] {
  const code = stripComments(source);
  const refs: ImportRef[] = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^;"'`]*?\bfrom\s*)?["']([^"']+)["']/g)) {
    refs.push({ specifier: m[2] ?? "", typeOnly: m[1] !== undefined });
  }
  for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    refs.push({ specifier: m[1] ?? "", typeOnly: false });
  }
  return refs;
}

/** Why a browser file's imports are not allowed. Empty when they are. */
function browserImportProblems(source: string): string[] {
  const problems: string[] = [];
  for (const { specifier, typeOnly } of findImports(source)) {
    if (typeOnly) continue;
    if (specifier.startsWith("@dues-banshee/")) {
      problems.push(`${specifier}: must be \`import type\``);
    } else if (!ALLOWED_VALUE_IMPORTS.has(specifier) && !/\.module\.css$/.test(specifier)) {
      problems.push(`${specifier}: value import not allowed`);
    }
  }
  return problems;
}

describe("browser import scanner", () => {
  it("accepts type-only package imports and the allowed value imports", () => {
    const ok = [
      '"use client";',
      'import { useEffect, useRef } from "react";',
      'import type { Db } from "@dues-banshee/db";',
      'import { routeRealtimeEvent } from "./realtime-events";',
      "import {",
      "  CALL_COPY,",
      "  type CallView,",
      '} from "@/lib/call/call-copy";',
      'import { startCall, type StartCallView } from "@/app/(debtor)/debtors/[id]/call-actions";',
      'import { startCallSession } from "@/lib/call/call-session";',
      'import type { StartCallControlsData } from "@/lib/debtor/build-start-call-controls";',
      'import styles from "./call-client.module.css";',
      '// import { handleEnd } from "@dues-banshee/voice";',
      "export const A = 1;",
    ].join("\n");
    expect(findImports(ok).map((i) => i.specifier)).toEqual([
      "react",
      "@dues-banshee/db",
      "./realtime-events",
      "@/lib/call/call-copy",
      "@/app/(debtor)/debtors/[id]/call-actions",
      "@/lib/call/call-session",
      "@/lib/debtor/build-start-call-controls",
      "./call-client.module.css",
    ]);
    expect(browserImportProblems(ok)).toEqual([]);
  });

  it("fails a sample with a value import from @dues-banshee/*, however it is written", () => {
    expect(browserImportProblems('import { handleEnd } from "@dues-banshee/voice";')).toEqual([
      "@dues-banshee/voice: must be `import type`",
    ]);
    // An inline `type` keeps a side-effect import under verbatimModuleSyntax: not allowed.
    expect(browserImportProblems('import { type Db } from "@dues-banshee/db";')).toEqual([
      "@dues-banshee/db: must be `import type`",
    ]);
    expect(browserImportProblems('import "@dues-banshee/agent";')).toEqual(["@dues-banshee/agent: must be `import type`"]);
    expect(browserImportProblems('export { x } from "@dues-banshee/engine";')).toEqual([
      "@dues-banshee/engine: must be `import type`",
    ]);
    expect(browserImportProblems('const m = await import("@dues-banshee/db");')).toEqual([
      "@dues-banshee/db: must be `import type`",
    ]);
  });

  it("fails a sample with a value import outside the allowed list", () => {
    expect(browserImportProblems('import { getDb } from "@/lib/db";')).toEqual(["@/lib/db: value import not allowed"]);
    expect(browserImportProblems('import { revalidatePath } from "next/cache";')).toEqual([
      "next/cache: value import not allowed",
    ]);
    expect(browserImportProblems('import { x } from "./start-call";')).toEqual(["./start-call: value import not allowed"]);
  });
});

describe("browser call files import no server code", () => {
  it.each(BROWSER_CALL_FILES)("%s imports @dues-banshee/* as types only and nothing else but the allowed values", (file) => {
    expect(ALL_SOURCES).toContain(file);
    expect(isClientFile(file, read(file))).toBe(true);
    expect(browserImportProblems(read(file))).toEqual([]);
  });
});
