import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

/**
 * The database handle every query function takes. Both the Neon driver (production) and the PGlite
 * driver (tests) produce a value of this type, and so do transactions opened from either.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Opens a pooled connection to Postgres over WebSockets. Node 22 has a global `WebSocket`, so the
 * `ws` package isn't needed. Callers close the pool when done.
 */
export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}
