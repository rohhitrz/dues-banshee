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

/** Distinct ladder-step names quoted inside one bracket literal. */
function distinctStepNames(literal: string): Set<string> {
  const found = new Set<string>();
  for (const quoted of literal.matchAll(/["'`]([a-z_]+)["'`]/g)) {
    const name = quoted[1];
    if (name !== undefined && STEP_ORDER.includes(name)) found.add(name);
  }
  return found;
}

/**
 * Array or `new Set([...])` literals (no nested brackets) naming two or more distinct ladder steps,
 * in any order. The approval-step set lives in the Engine only. A Record keyed by step is not a bracket literal.
 */
function stepSetHits(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(/\[[^[\]]*\]/g)) {
    if (distinctStepNames(match[0]).size >= 2) {
      hits.push(`${display(file)}:${lineOf(text, match.index ?? 0)}: ladder-step set literal`);
    }
  }
  return hits;
}

const RANK_METHODS = "(?:indexOf|lastIndexOf|findIndex|findLastIndex)";
const RANK_ON_CONST = new RegExp(`LADDER_STEPS\\s*\\.\\s*${RANK_METHODS}\\s*\\(`, "g");
const RANK_ON_LITERAL = new RegExp(`\\[[^[\\]]*\\](?:\\s*as\\s+const\\s*\\))?\\s*\\.\\s*${RANK_METHODS}\\s*\\(`, "g");
const SPREADS_LADDER_STEPS = /\.\.\.\s*LADDER_STEPS\b/;
/**
 * `indexOf`, `lastIndexOf`, `findIndex` or `findLastIndex` called on LADDER_STEPS, or directly on a
 * bracket literal holding a ladder step or spreading LADDER_STEPS. Step ranking lives in the Engine
 * `stepRank` only.
 */
function stepRankHits(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(RANK_ON_CONST)) {
    hits.push(`${display(file)}:${lineOf(text, match.index ?? 0)}: ladder-step ranking`);
  }
  for (const match of text.matchAll(RANK_ON_LITERAL)) {
    if (distinctStepNames(match[0]).size >= 1 || SPREADS_LADDER_STEPS.test(match[0])) {
      hits.push(`${display(file)}:${lineOf(text, match.index ?? 0)}: ladder-step ranking`);
    }
  }
  return hits;
}

/**
 * Any static, side-effect, dynamic or `require` import of `@dues-banshee/voice` (voice depends on
 * agent, not the reverse).
 */
function voiceImportHits(file: string, text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(/(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']@dues-banshee\/voice(?![\w-])/g)) {
    hits.push(`${display(file)}:${lineOf(text, match.index ?? 0)}: voice import in agent`);
  }
  return hits;
}

const files = [...listSourceFiles(AGENT_SRC), ...listSourceFiles(WEB_ROOT)];
const agentFiles = listSourceFiles(AGENT_SRC);
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

  it("never writes two or more ladder steps in one array or Set literal", () => {
    const offenders: string[] = [];
    for (const file of files) {
      offenders.push(...stepSetHits(file, contents.get(file) ?? ""));
    }
    expect(offenders).toEqual([]);
  });

  it("never ranks ladder steps with indexOf or findIndex", () => {
    const offenders: string[] = [];
    for (const file of files) {
      offenders.push(...stepRankHits(file, contents.get(file) ?? ""));
    }
    expect(offenders).toEqual([]);
  });

  it("never imports @dues-banshee/voice from packages/agent/src", () => {
    const offenders: string[] = [];
    for (const file of agentFiles) {
      offenders.push(...voiceImportHits(file, contents.get(file) ?? ""));
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

  it("flags a ladder-step set literal and passes a Record or a single-step array", () => {
    const set = `const s = new Set(["voice_call", "legal_notice"]);`;
    const plain = `const a = [\n  "odr_pack",\n  'whatsapp_nudge',\n];`;
    expect(stepSetHits(sample, set)).toEqual(["apps/web/sample.ts:1: ladder-step set literal"]);
    expect(stepSetHits(sample, plain)).toEqual(["apps/web/sample.ts:1: ladder-step set literal"]);
    const record = `const ADDRESS_REQUIRED = { whatsapp_nudge: true, voice_call: false, odr_pack: false };`;
    const single = `const one = ["voice_call"];\nconst twice = ["voice_call", "voice_call"];`;
    const other = `const names = ["alpha", "beta"];`;
    expect(stepSetHits(sample, `${record}\n${single}\n${other}`)).toEqual([]);
  });

  it("flags step ranking with indexOf or findIndex and passes other indexOf calls", () => {
    const onConst = `const r = LADDER_STEPS.indexOf(step);\nconst f = LADDER_STEPS\n  .findIndex((s) => s === step);`;
    const onLiteral = `const r = ["voice_call", "legal_notice"].indexOf(step);\nconst q = (["odr_pack"] as const).findIndex((s) => s === step);`;
    expect(stepRankHits(sample, onConst)).toEqual([
      "apps/web/sample.ts:1: ladder-step ranking",
      "apps/web/sample.ts:2: ladder-step ranking",
    ]);
    expect(stepRankHits(sample, onLiteral)).toEqual([
      "apps/web/sample.ts:1: ladder-step ranking",
      "apps/web/sample.ts:2: ladder-step ranking",
    ]);
    const near = `const i = PLACEHOLDERS.indexOf(x);\nconst j = ["a", "b"].indexOf(x);\nconst k = LADDER_STEPS.map(String);`;
    expect(stepRankHits(sample, near)).toEqual([]);
  });
  it("flags lastIndexOf and findLastIndex on LADDER_STEPS and on step literals", () => {
    const onConst = `const a = LADDER_STEPS.lastIndexOf(step);\nconst b = LADDER_STEPS\n  .findLastIndex((s) => s === step);`;
    const onLiteral = `const c = ["voice_call", "legal_notice"].lastIndexOf(step);\nconst d = (["odr_pack"] as const).findLastIndex((s) => s === step);`;
    expect(stepRankHits(sample, onConst)).toEqual([
      "apps/web/sample.ts:1: ladder-step ranking",
      "apps/web/sample.ts:2: ladder-step ranking",
    ]);
    expect(stepRankHits(sample, onLiteral)).toEqual([
      "apps/web/sample.ts:1: ladder-step ranking",
      "apps/web/sample.ts:2: ladder-step ranking",
    ]);
    const near = `const e = PLACEHOLDERS.lastIndexOf(x);\nconst f = ["a", "b"].findLastIndex((s) => s === x);\nconst g = LADDER_STEPS.at(-1);`;
    expect(stepRankHits(sample, near)).toEqual([]);
  });
  it("flags a literal that spreads LADDER_STEPS and passes other spreads", () => {
    const spread = `const a = [...LADDER_STEPS].indexOf(step);\nconst b = [...LADDER_STEPS, "x"].findIndex((s) => s === step);\nconst c = ([...LADDER_STEPS] as const).lastIndexOf(step);\nconst d = [ ... LADDER_STEPS ].findLastIndex((s) => s === step);`;
    expect(stepRankHits(sample, spread)).toEqual([
      "apps/web/sample.ts:1: ladder-step ranking",
      "apps/web/sample.ts:2: ladder-step ranking",
      "apps/web/sample.ts:3: ladder-step ranking",
      "apps/web/sample.ts:4: ladder-step ranking",
    ]);
    const near = `const e = [...OTHER_STEPS].indexOf(x);\nconst f = [...LADDER_STEPS].map(String);\nconst g = [...LADDER_STEPS_COPY].indexOf(x);`;
    expect(stepRankHits(sample, near)).toEqual([]);
  });

  it("flags imports of @dues-banshee/voice and passes lookalike package names", () => {
    const staticImport = `import { x } from "@dues-banshee/voice";`;
    const subpath = `import { y } from '@dues-banshee/voice/persona';`;
    const dynamic = `const m = await import("@dues-banshee/voice");`;
    expect(voiceImportHits(sample, staticImport)).toEqual(["apps/web/sample.ts:1: voice import in agent"]);
    expect(voiceImportHits(sample, subpath)).toEqual(["apps/web/sample.ts:1: voice import in agent"]);
    expect(voiceImportHits(sample, dynamic)).toEqual(["apps/web/sample.ts:1: voice import in agent"]);
    const near = `import { x } from "@dues-banshee/voice-x";\nimport { e } from "@dues-banshee/engine";`;
    expect(voiceImportHits(sample, near)).toEqual([]);
  });
  it("flags a side-effect import and a require of @dues-banshee/voice", () => {
    const sideEffect = `import "@dues-banshee/voice";\nimport '@dues-banshee/voice/persona';`;
    const required = `const v = require("@dues-banshee/voice");\nconst w = require( '@dues-banshee/voice/persona' );`;
    expect(voiceImportHits(sample, sideEffect)).toEqual([
      "apps/web/sample.ts:1: voice import in agent",
      "apps/web/sample.ts:2: voice import in agent",
    ]);
    expect(voiceImportHits(sample, required)).toEqual([
      "apps/web/sample.ts:1: voice import in agent",
      "apps/web/sample.ts:2: voice import in agent",
    ]);
    const near = `import "@dues-banshee/voice-x";\nimport "@dues-banshee/engine";\nconst a = require("@dues-banshee/voicemail");\nconst b = require("@dues-banshee/engine");\n// import "@dues-banshee/other"`;
    expect(voiceImportHits(sample, near)).toEqual([]);
  });
});
