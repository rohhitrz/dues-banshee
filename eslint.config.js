import tseslint from "typescript-eslint";

const restrictedGlobals = ["Date", "process", "fetch", "setTimeout", "setInterval", "performance"];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/coverage/**", "**/.turbo/**", "**/.vercel/**"],
  },
  ...tseslint.configs.recommended,
  {
    // packages/engine must stay pure: no clock, no I/O, no randomness.
    files: ["packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...restrictedGlobals.map((name) => ({
          name,
          message: `packages/engine is pure: ${name} is not allowed. Inject it as an argument instead.`,
        })),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["node:*"], message: "packages/engine is pure: no Node built-ins." },
            { group: ["fs", "path", "http", "https", "net", "child_process"], message: "packages/engine is pure: no I/O modules." },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "packages/engine is pure: Math.random is not allowed." },
      ],
    },
  },
);
