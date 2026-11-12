import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "../src/client";
import { resetDemo } from "../src/reset";

export const REFUSAL_MESSAGE = "Refusing to reset: this deletes every supplier, buyer and invoice. Re-run with --yes.";

/** What `main` needs from the outside world. Tests pass stubs. */
export interface ResetDemoDeps {
  createDb: (url: string) => { db: Db; close: () => Promise<void> };
  resetDemo: (db: Db) => Promise<void>;
  log: (message: string) => void;
  error: (message: string) => void;
}

const defaultDeps: ResetDemoDeps = {
  createDb,
  resetDemo,
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** The host and port of a connection string. Never the user, password or database name. */
function targetHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Runs the demo reset and returns the process exit code. Without `--yes` it refuses before
 * touching the environment or creating a client.
 */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: ResetDemoDeps = defaultDeps,
): Promise<number> {
  if (!argv.includes("--yes")) {
    deps.error(REFUSAL_MESSAGE);
    return 1;
  }

  const url = env["DATABASE_URL"];
  if (!url) {
    deps.error("DATABASE_URL is not set");
    return 1;
  }

  const host = targetHost(url);
  if (host === null) {
    deps.error("DATABASE_URL is not a valid URL");
    return 1;
  }
  deps.log(`Resetting demo data on ${host}`);

  const { db, close } = deps.createDb(url);
  try {
    await deps.resetDemo(db);
    deps.log("Demo data reset.");
    return 0;
  } catch (err) {
    deps.error(`Demo reset failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await close();
  }
}

// Run only when executed as a script (`tsx scripts/reset-demo.ts`), not when a test imports `main`.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
