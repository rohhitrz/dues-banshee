import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Requirements 1.2 and 3.2: model IDs live only in models.ts, and the agent and web code never
// restate the Engine's ladder timing or step order.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const AGENT_SRC = join(REPO_ROOT, "packages", "agent", "src");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const MODELS_FILE = join(AGENT_SRC, "models.ts");

const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  ".vercel",
  "dist",
  "coverage",
  "test",
  "tests",
  "__tests__",
]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The Engine's ladder order; the only place this order may be written down. */
const STEP_ORDER = ["whatsapp_nudge", "whatsapp_paylink", "voice_call", "legal_notice", "odr_pack"];

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...listSourceFiles(full));
    } else if (
      entry.isFile() &&
      SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) &&
      !TEST_FILE.test(entry.name)
    ) {
      found.push(full);
    }
  }
  return found.sort();
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function display(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}

const MODEL_ID_PATTERN = /claude-|gpt-/;
const TIMING_PATTERN = /stepGapDays|DEFAULT_STEP_GAP_DAYS/;

/** `file:line: text` for every line of `text` matching `pattern`. */
function lineHits(file: string, text: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (pattern.test(line)) hits.push(`${display(file)}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

/**
 * Array literals (no nested brackets) whose quoted strings name at least three ladder steps in
 * ascending ladder order. A Record keyed by step, a union type or a lone step string is not an array.
 */
function stepOrderArrayHits(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(/\[[^[\]]*\]/g)) {
    const names: string[] = [];
    for (const quoted of match[0].matchAll(/["'`]([a-z_]+)["'`]/g)) {
      const name = quoted[1];
      if (name !== undefined && STEP_ORDER.includes(name)) names.push(name);
    }
    let longest = 0;
    let run = 0;
    let lastRank = -1;
    for (const name of names) {
      const rank = STEP_ORDER.indexOf(name);
      run = rank > lastRank ? run + 1 : 1;
      lastRank = rank;
      longest = Math.max(longest, run);
    }
    if (longest >= 3) {
      const at = match.index ?? 0;
      hits.push(`${display(file)}:${lineOf(text, at)}: step-order array literal`);
    }
  }
  return hits;
}

const files = [...listSourceFiles(AGENT_SRC), ...listSourceFiles(WEB_ROOT)];
const contents = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));

describe("source lint", () => {
  it("scans the agent and web source and skips tests and build output", () => {
    const shown = files.map(display);
    expect(shown).toContain("packages/agent/src/models.ts");
    expect(shown).toContain("packages/agent/src/draft-step.ts");
    expect(shown).toContain("apps/web/lib/graveyard/labels.ts");
    expect(shown.filter((f) => f.includes("/node_modules/") || f.includes("/.next/"))).toEqual([]);
    expect(shown.filter((f) => f.startsWith("apps/web/test/") || f.startsWith("packages/agent/test/"))).toEqual([]);
  });

  it("keeps every claude- and gpt- model ID inside packages/agent/src/models.ts", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === MODELS_FILE) continue;
      offenders.push(...lineHits(file, contents.get(file) ?? "", MODEL_ID_PATTERN));
    }
    expect(offenders).toEqual([]);
  });

  it("finds the model IDs in models.ts, so the check above is not vacuous", () => {
    const hits = lineHits(MODELS_FILE, contents.get(MODELS_FILE) ?? "", MODEL_ID_PATTERN);
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("never restates stepGapDays or DEFAULT_STEP_GAP_DAYS", () => {
    const offenders: string[] = [];
    for (const file of files) {
      offenders.push(...lineHits(file, contents.get(file) ?? "", TIMING_PATTERN));
    }
    expect(offenders).toEqual([]);
  });

  it("never writes the ladder steps as an array literal in order", () => {
    const offenders: string[] = [];
    for (const file of files) {
      offenders.push(...stepOrderArrayHits(file, contents.get(file) ?? ""));
    }
    expect(offenders).toEqual([]);
  });
});

describe("source lint detectors", () => {
  const sample = join(REPO_ROOT, "apps", "web", "sample.ts");

  it("flags a step-order array on one line and across lines", () => {
    const oneLine = `const a = ["whatsapp_nudge", "whatsapp_paylink", "voice_call", "legal_notice", "odr_pack"];`;
    const multiLine = `const b = [\n  'whatsapp_nudge',\n  'whatsapp_paylink',\n  'voice_call',\n];`;
    expect(stepOrderArrayHits(sample, oneLine)).toEqual(["apps/web/sample.ts:1: step-order array literal"]);
    expect(stepOrderArrayHits(sample, multiLine)).toEqual(["apps/web/sample.ts:1: step-order array literal"]);
  });

  it("does not flag a step-keyed Record, a union type or a short array", () => {
    const record = `const T = { whatsapp_nudge: "a", whatsapp_paylink: "b", voice_call: "c", legal_notice: "d", odr_pack: "e" };`;
    const union = `type S = "whatsapp_nudge" | "whatsapp_paylink" | "voice_call";`;
    const pair = `const p = ["whatsapp_nudge", "whatsapp_paylink"];`;
    const unordered = `const u = ["odr_pack", "legal_notice", "voice_call"];`;
    expect(stepOrderArrayHits(sample, `${record}\n${union}\n${pair}\n${unordered}`)).toEqual([]);
  });

  it("flags model IDs and timing names with file and line", () => {
    expect(lineHits(sample, `a\nconst m = "claude-x";`, MODEL_ID_PATTERN)).toEqual([
      'apps/web/sample.ts:2: const m = "claude-x";',
    ]);
    expect(lineHits(sample, `{ stepGapDays: 7 }`, TIMING_PATTERN)).toEqual([
      "apps/web/sample.ts:1: { stepGapDays: 7 }",
    ]);
  });
});
