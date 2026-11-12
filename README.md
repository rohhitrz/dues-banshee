# Dues Banshee

An AI collections agent that chases unpaid invoices for Indian MSME suppliers over WhatsApp and voice, in Hindi and English.

Built with Kiro for Kiroween 2026.

Status: in progress

## Database

The schema lives in `packages/db`. Every command below needs `DATABASE_URL` set to a Postgres connection string.

| Command | What it does |
| --- | --- |
| `pnpm --filter @dues-banshee/db db:migrate` | Applies the migrations in `packages/db/drizzle`. |
| `pnpm --filter @dues-banshee/db db:seed` | Adds the demo supplier, bank rate, buyers and invoices. Running it again changes nothing. |
| `pnpm --filter @dues-banshee/db db:reset-demo -- --yes` | Deletes every supplier, buyer and invoice (and the tables that hang off them), then reseeds the demo data in one transaction. The `config` table is kept. |

`db:reset-demo` refuses to run without `--yes`. It prints only the database host, never the user or password. If the reseed fails, the delete is rolled back.

## License

MIT. See [LICENSE](LICENSE).
