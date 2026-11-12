import { createDb, type Db } from "@dues-banshee/db";

/**
 * The only way route handlers, server actions and `auth.ts` reach the database.
 * Callers close the client in `finally`.
 */
export function getDb(): { db: Db; close: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return createDb(url);
}
