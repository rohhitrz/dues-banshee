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

describe("apps/web proxy import ban", () => {
  it("reports exactly one error for a proxy.ts snippet importing ./auth", async () => {
    const snippet = 'import { auth } from "./auth";\nexport const proxy = auth;\n';
    const messages = await lintText(snippet, "apps/web/proxy.ts");

    expect(messages.map((m) => [m.line, m.severity, m.ruleId])).toEqual([[1, 2, "no-restricted-imports"]]);
    expect(messages[0]?.message).toContain("must not import auth.ts");
  });

  it.each(["@/auth", "@/lib/db", "./lib/db", "@dues-banshee/db"])(
    "reports exactly one error for auth.config.ts importing %s",
    async (specifier) => {
      const snippet = `import * as m from "${specifier}";\nexport const v = m;\n`;
      const messages = await lintText(snippet, "apps/web/auth.config.ts");

      expect(messages.map((m) => [m.severity, m.ruleId])).toEqual([[2, "no-restricted-imports"]]);
    },
  );

  it("does not apply the ban to other files", async () => {
    const snippet = 'import { auth } from "./auth";\nexport const v = auth;\n';
    const messages = await lintText(snippet, "apps/web/lib/other.ts");

    expect(messages.filter((m) => m.ruleId === "no-restricted-imports")).toEqual([]);
  });

  it.each(["apps/web/proxy.ts", "apps/web/auth.config.ts"])("reports no errors for the real %s", async (file) => {
    expect(await lintRealFile(file)).toEqual([]);
  });
});
