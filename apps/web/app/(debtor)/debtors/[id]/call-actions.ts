"use server";

import { SupplierNotFoundError, getSupplier, type Db, type Supplier } from "@dues-banshee/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { requestOrigin, startCallCore, type StartCallView } from "@/lib/call/start-call";

export type { StartCallView };

const STALE_URL = "/signin?error=SessionExpired";
const FAILED_TEXT = "The call could not be started. Please try again.";

/** The supplier comes from the session only. Any `supplierId` in the form data is never read. */
async function sessionSupplierId(): Promise<string> {
  const session = await auth();
  const supplierId = session?.supplierId;
  if (!supplierId) redirect("/signin");
  return supplierId;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

type Scoped<T> = { stale: true } | { stale: false; value: T };

/**
 * Runs `fn` for the session supplier. A supplier that no longer exists (stale session) comes back as
 * `{ stale: true }`; the caller redirects outside any `try`.
 */
async function withSupplier<T>(
  supplierId: string,
  fn: (db: Db, supplier: Supplier) => Promise<T>,
): Promise<Scoped<T>> {
  const { db, close } = getDb();
  try {
    const supplier = await getSupplier(db, supplierId);
    return { stale: false, value: await fn(db, supplier) };
  } catch (err) {
    if (err instanceof SupplierNotFoundError) return { stale: true };
    throw err;
  } finally {
    await close().catch(() => console.error("start call: close failed"));
  }
}

/**
 * "Start call" on an Invoice_Panel. Reads only `invoiceId` and the optional Demo_Override `today` from the
 * form. The instant is the server clock; the logic lives in `startCallCore`, which takes `now` as a
 * parameter so tests can fix it. No session redirects to /signin, a Stale_Session to the SessionExpired page.
 */
export async function startCall(_prev: StartCallView | null, form: FormData): Promise<StartCallView> {
  const supplierId = await sessionSupplierId();
  const invoiceId = field(form, "invoiceId");
  const origin = requestOrigin(await headers());

  let outcome: Scoped<StartCallView>;
  try {
    outcome = await withSupplier(supplierId, (db, supplier) =>
      startCallCore(
        {
          db,
          supplier,
          now: new Date(),
          origin,
          apiKeyConfigured: (process.env.OPENAI_API_KEY ?? "") !== "",
        },
        { invoiceId, today: field(form, "today") },
      ),
    );
  } catch (err) {
    // Name only: a driver error message can carry SQL text or a connection string.
    console.error("start call: unexpected failure", err instanceof Error ? err.name : "unknown");
    return { invoiceId: /^[0-9a-f-]{36}$/i.test(invoiceId) ? invoiceId : "", text: FAILED_TEXT, role: "alert" };
  }
  if (outcome.stale) redirect(STALE_URL);
  return outcome.value;
}
