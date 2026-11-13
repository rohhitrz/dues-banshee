// The package tsconfig sets `types: []` to keep Node globals out of src. This test file alone needs Node types.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RULE_IDS, RULE_SOURCES } from "../src/rule-ids";

// packages/engine/test -> repo root
const LEGAL_RULES_PATH = fileURLToPath(
  new URL("../../../.kiro/steering/legal-rules.md", import.meta.url),
);

/** Rows of the rule table: `| \`ID\` | Rule | Source |`. The header and `|---|` rows have no backticked ID. */
function parseRuleTable(markdown: string): { id: string; source: string }[] {
  const rows: { id: string; source: string }[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|.*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      rows.push({ id: match[1].trim(), source: match[2].replace(/^`|`$/g, "").trim() });
    }
  }
  return rows;
}

const rows = parseRuleTable(readFileSync(LEGAL_RULES_PATH, "utf8"));

describe("RULE_SOURCES matches the rule table in legal-rules.md", () => {
  it("parses seven rows, one per rule ID", () => {
    expect(rows.map((row) => row.id).sort()).toEqual([...RULE_IDS].sort());
  });

  it("has exactly one RULE_SOURCES entry per rule ID", () => {
    expect(Object.keys(RULE_SOURCES).sort()).toEqual([...RULE_IDS].sort());
  });

  it("gives each rule ID the exact Source column text of its row", () => {
    expect(Object.fromEntries(rows.map((row) => [row.id, row.source]))).toEqual({
      ...RULE_SOURCES,
    });
  });
});
