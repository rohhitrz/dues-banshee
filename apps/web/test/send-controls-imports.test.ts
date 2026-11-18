/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Req 8.5: SendControls runs in the browser, so no server-only package may reach its bundle.
const SOURCE = readFileSync(fileURLToPath(new URL("../components/debtor/send-controls.tsx", import.meta.url)), "utf8");

/** Module specifiers of every import, export-from and dynamic import in the file. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;
  for (const match of text.matchAll(pattern)) found.push(match[1] ?? "");
  return found;
}

describe("send-controls.tsx imports", () => {
  it("is a client component", () => {
    expect(SOURCE.startsWith('"use client";')).toBe(true);
  });

  it("imports nothing from @dues-banshee/agent, @dues-banshee/db or twilio", () => {
    const banned = specifiers(SOURCE).filter(
      (s) => s === "twilio" || s.startsWith("twilio/") || s.startsWith("@dues-banshee/agent") || s.startsWith("@dues-banshee/db"),
    );
    expect(banned).toEqual([]);
  });

  it("imports only react, the send actions, the data type and its stylesheet", () => {
    expect(specifiers(SOURCE)).toEqual([
      "react",
      "@/app/(debtor)/debtors/[id]/send-actions",
      "@/lib/debtor/build-send-controls",
      "./send-controls.module.css",
    ]);
  });
});
