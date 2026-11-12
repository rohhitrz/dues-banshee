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
      "no-restricted-properties": ["error", mathRandom("packages/engine")],
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
          selector: "Literal[raw=/^(\\d[\\d_]*)?\\.\\d|^\\d[\\d_]*[eE]/]",
          message: "no fractional or exponent literals in packages/ledger",
        },
      ],
    },
  },
);
