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

/**
 * Import allowlist as no-restricted-syntax selectors (no-restricted-imports cannot see `export ... from`,
 * `require`, `import()` or `import x = require()`). `allowed` is a regex body matched against the whole
 * specifier. Type-only imports are ImportDeclarations too, so they are held to the same list.
 */
const edgeImportAllowlist = (file, allowed) => {
  const bad = `:not([source.value=/^(?:${allowed})$/])`;
  const message = `${file.split("/").pop()} may only import next, next/*, next-auth, next-auth/*${
    file.endsWith("proxy.ts") ? " and ./auth.config" : ""
  }: it is bundled for the proxy and must not reach auth.ts, Db code or any other module.`;
  return {
    files: [file],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration[source]"].map((n) => ({
          selector: `${n}${bad}`,
          message,
        })),
        { selector: `TSExternalModuleReference:not([expression.value=/^(?:${allowed})$/])`, message },
        { selector: "TSImportType", message },
        { selector: "CallExpression[callee.name='require']", message },
        { selector: "ImportExpression", message: "dynamic import() is not allowed here: it would bypass the import allowlist." },
      ],
    },
  };
};
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
      "no-restricted-properties": [
        "error",
        mathRandom("packages/engine"),
        // Bare `parseFloat` stays allowed in the engine, but `globalThis.parseFloat` is banned as in the ledger.
        ...globalThisBans("packages/engine", ["parseFloat"]),
      ],
      "no-restricted-syntax": [
        "error",
        {
          // A trailing point (`1.`, `1.e3`). Fractional literals such as `0.5` stay legal in the engine.
          selector: "Literal[raw=/^\\d[\\d_]*\\.(?!\\d)/]",
          message: "no trailing-point number literals in packages/engine",
        },
      ],
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
  // proxy.ts and auth.config.ts are bundled for the edge-style proxy. They may only decode the
  // JWT cookie, so they get an ALLOWLIST of imports: anything not listed (auth.ts, db code, `@/`
  // aliases, other relative paths, workspace packages, other bare packages) fails lint.
  edgeImportAllowlist("apps/web/proxy.ts", String.raw`next(\/.*)?|next-auth(\/.*)?|\.\/auth\.config`),
  edgeImportAllowlist("apps/web/auth.config.ts", String.raw`next(\/.*)?|next-auth(\/.*)?`),
);
