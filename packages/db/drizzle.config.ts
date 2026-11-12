import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Read from the environment only. `db:generate` does not connect, so this may be empty then.
    url: process.env.DATABASE_URL ?? "",
  },
});
