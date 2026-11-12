import { describe, expect, it } from "vitest";
import pkg from "../package.json";

describe("engine package.json", () => {
  it("has no runtime dependencies", () => {
    const dependencies = (pkg as { dependencies?: Record<string, string> }).dependencies;
    expect(Object.keys(dependencies ?? {})).toEqual([]);
  });
});
