import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LADDER_STEPS, RULE_IDS } from "@dues-banshee/engine";
import { z } from "zod";
import { BLOCK_REASONS } from "../core/citations";
import { MODEL_OUTPUT_SCHEMA } from "../core/model-output";

/** `<repo>/evals/draft-step`, resolved from this file so it works from the CLI and from Vitest. */
export const DEFAULT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "evals",
  "draft-step",
);

export const FIXTURE_SCHEMA = z.strictObject({
  name: z.string().regex(/^[a-z0-9-]+$/),
  context: z.strictObject({
    subject: z.enum(["sharma_2026_11_12", "synthetic"]),
    step: z.enum(LADDER_STEPS),
    language: z.enum(["hinglish", "english"]),
    allowed: z.array(z.enum(RULE_IDS)),
    bankRateExists: z.boolean(),
    overdue: z.boolean(),
  }),
  output: MODEL_OUTPUT_SCHEMA,
  expected: z.union([z.literal("accept"), z.enum(BLOCK_REASONS)]),
});

export type Fixture = z.infer<typeof FIXTURE_SCHEMA>;

/** A fixture file (or the folder) that cannot be used. `file` names it; `issues` say why. */
export class FixtureError extends Error {
  readonly file: string;
  readonly issues: readonly string[];

  constructor(file: string, issues: readonly string[]) {
    super(`${file}: ${issues.join("; ")}`);
    this.name = "FixtureError";
    this.file = file;
    this.issues = issues;
  }
}

/**
 * Reads every `*.json` in `dir` in name order and validates it. Throws `FixtureError` on bad JSON,
 * a schema failure, a duplicate fixture name, or no files at all (an empty run must not pass).
 */
export function loadFixtures(dir: string = DEFAULT_DIR): Fixture[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((entry) => entry.endsWith(".json"))
      .sort();
  } catch (error) {
    throw new FixtureError(dir, [error instanceof Error ? error.message : "cannot read folder"]);
  }
  if (names.length === 0) throw new FixtureError(dir, ["no fixture files found"]);

  const fixtures: Fixture[] = [];
  const seen = new Map<string, string>();
  for (const fileName of names) {
    const file = join(dir, fileName);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new FixtureError(file, [`invalid JSON: ${error instanceof Error ? error.message : "unreadable"}`]);
    }
    const parsed = FIXTURE_SCHEMA.safeParse(json);
    if (!parsed.success) {
      throw new FixtureError(
        file,
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
      );
    }
    const earlier = seen.get(parsed.data.name);
    if (earlier !== undefined) {
      throw new FixtureError(file, [`duplicate fixture name "${parsed.data.name}" (also in ${earlier})`]);
    }
    seen.set(parsed.data.name, fileName);
    fixtures.push(parsed.data);
  }
  return fixtures;
}
