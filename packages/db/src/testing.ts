import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import type { Db } from "./client";
import * as schema from "./schema";

/** The committed migrations, resolved from this file rather than from the working directory. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export interface TestDb {
  db: Db;
  /** The underlying PGlite instance, for `clone()` and raw SQL. */
  pglite: PGlite;
  close: () => Promise<void>;
}

function wrap(pglite: PGlite): TestDb {
  return { db: drizzle(pglite, { schema }), pglite, close: () => pglite.close() };
}

/** An in-memory Postgres with every committed migration applied. */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  const test = wrap(pglite);
  await migrate(drizzle(pglite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
  return test;
}

/**
 * A copy of `template` with its current contents. Cheaper than migrating again, and the copy is
 * independent: writes to it don't touch the template.
 */
export async function cloneTestDb(template: TestDb): Promise<TestDb> {
  // `clone()` is typed as the interface, but on a PGlite instance it returns a PGlite.
  return wrap((await template.pglite.clone()) as PGlite);
}
