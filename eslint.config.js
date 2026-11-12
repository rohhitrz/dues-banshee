import tseslint from "typescript-eslint";

const restrictedGlobals = ["Date", "process", "fetch", "setTimeout", "setInterval", "performance"];

/** Purity rules shared by packages/engine and packages/ledger. `pkg` names the package in messages. */
const purityGlobals = (pkg, extraNames = []) => [
  "error",
  ...[...restrictedGlobals, ...extraNames].map((name) => ({
    name,
    message: `${pkg} is pure: ${name} is not allowed. Inject it as an argument instead.`,
  })),
];

const purityImports = (pkg) => [
  "error",
  {
    patterns: [
      { group: ["node:*"], message: `${pkg} is pure: no Node built-ins.` },
      { group: ["fs", "path", "http", "https", "net", "child_process"], message: `${pkg} is pure: no I/O modules.` },
    ],
  },
];

const mathRandom = (pkg) => ({
  object: "Math",
  property: "random",
  message: `${pkg} is pure: Math.random is not allowed.`,
});
/**
 * `globalThis.X` reaches the same globals that no-restricted-globals bans by bare name, so ban it
 * for every restricted global. `globalThis.Math` is banned whole, because
 * `const M = globalThis.Math; M.random()` would otherwise get past mathRandom.
 */
const globalThisBans = (pkg, extraNames = []) =>
  [...restrictedGlobals, ...extraNames, "Math"].map((property) => ({
    object: "globalThis",
    property,
    message: `${pkg} is pure: globalThis.${property} is not allowed. Inject it as an argument instead.`,
  }));

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/coverage/**", "**/.turbo/**", "**/.vercel/**"],
  },
  ...tseslint.configs.recommended,
  {
    // packages/engine must stay pure: no clock, no I/O, no randomness.
    files: ["packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-globals": purityGlobals("packages/engine"),
      "no-restricted-imports": purityImports("packages/engine"),
      "no-restricted-properties": ["error", mathRandom("packages/engine"), ...globalThisBans("packages/engine")],
    },
  },
  {
    // packages/ledger is pure too, and additionally must never touch floating point:
    // money is integer paise, so no parseFloat, no .toFixed, no fractional/exponent literals.
    // Flat config merges rules by key, so this block carries the complete lists for ledger files.
    files: ["packages/ledger/src/**/*.ts"],
    rules: {
      "no-restricted-globals": purityGlobals("packages/ledger", ["parseFloat"]),
      "no-restricted-imports": purityImports("packages/ledger"),
      "no-restricted-properties": [
        "error",
        mathRandom("packages/ledger"),
        ...globalThisBans("packages/ledger", ["parseFloat"]),
        {
          object: "Number",
          property: "parseFloat",
          message: "packages/ledger is integer-only: Number.parseFloat is not allowed.",
        },
        // No `object`: bans `.toFixed` on any receiver.
        { property: "toFixed", message: "packages/ledger is integer-only: .toFixed is not allowed." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // `.5`, `0.5`, `1e3`, and a trailing point (`1.`, `1.e3`).
          selector: "Literal[raw=/^(\\d[\\d_]*)?\\.\\d|^\\d[\\d_]*[eE]|^\\d[\\d_]*\\./]",
          message: "no fractional or exponent literals in packages/ledger",
        },
      ],
    },
  },
  {
    // proxy.ts and auth.config.ts are bundled for the edge-style proxy. They may only decode the
    // JWT cookie, so they must not reach auth.ts (Credentials provider) or any database code.
    files: ["apps/web/proxy.ts", "apps/web/auth.config.ts"],
    rules: {
      // `patterns` use gitignore-style matching, so they catch any path to these modules
      // (`../web/lib/db`, `@/auth`) and subpaths (`@dues-banshee/db/testing`), not just exact names.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@dues-banshee/db", "@dues-banshee/db/*", "**/auth", "**/auth.ts", "**/auth.js", "**/lib/db*"],
              message:
                "proxy.ts and auth.config.ts must not import auth.ts or any Db code: build auth from auth.config.ts only, so the proxy bundle stays free of the provider and the database.",
            },
          ],
        },
      ],
      // A dynamic `import("./auth")` would get past the static import ban above.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "proxy.ts and auth.config.ts must not use dynamic import(): it would bypass the ban on importing auth.ts and Db code.",
        },
      ],
    },
  },
);
