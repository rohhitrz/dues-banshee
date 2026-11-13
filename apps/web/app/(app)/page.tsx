import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { GraveyardEmpty } from "@/components/graveyard/graveyard-empty";
import { LoadError } from "@/components/graveyard/load-error";
import { GraveyardPendingProvider, PendingDim } from "@/components/graveyard/pending-context";
import { TimeTravel } from "@/components/graveyard/time-travel";
import { TombstoneGrid } from "@/components/graveyard/tombstone-grid";
import { TotalsBar } from "@/components/graveyard/totals-bar";
import { getDb } from "@/lib/db";
import { loadGraveyardData, type GraveyardLoadResult } from "@/lib/graveyard/load";
import { resolveToday } from "@/lib/graveyard/today";
import styles from "./page.module.css";

// Today is read from the clock per request. `auth()` (cookies) and `searchParams` are dynamic
// APIs, so this route is never prerendered and `cacheComponents` is not enabled. If it is ever
// enabled, call `await connection()` from "next/server" before `Date.now()`.

async function load(supplierId: string, today: string): Promise<GraveyardLoadResult> {
  let handle: ReturnType<typeof getDb>;
  try {
    handle = getDb();
  } catch (err) {
    console.error("graveyard: database unavailable", err);
    return { kind: "error" };
  }
  try {
    return await loadGraveyardData(handle.db, supplierId, today);
  } finally {
    await handle.close().catch((err: unknown) => console.error("graveyard: close failed", err));
  }
}

export default async function GraveyardPage({
  searchParams,
}: {
  searchParams: Promise<{ today?: string | string[] }>;
}) {
  // The supplier comes from the session only; nothing in the URL, query or body is consulted.
  const session = await auth();
  const supplierId = session?.supplierId;
  if (!supplierId) redirect("/signin");

  const rawToday = (await searchParams).today;
  const { today, override } = resolveToday(Date.now(), rawToday);

  const result = await load(supplierId, today);
  if (result.kind === "stale") redirect("/signin?error=SessionExpired");

  if (result.kind === "error") {
    const raw = Array.isArray(rawToday) ? rawToday[0] : rawToday;
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Graveyard of dues</h1>
        <GraveyardPendingProvider>
          <TimeTravel override={override} />
        </GraveyardPendingProvider>
        <LoadError todayRaw={raw} />
      </main>
    );
  }

  const { view } = result;
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Graveyard of dues</h1>
      <GraveyardPendingProvider>
        <PendingDim>
          <TotalsBar totals={view.totals} rulesAsOf={view.rulesAsOf} today={view.today} />
        </PendingDim>
        <TimeTravel override={override} />
        <PendingDim>
          {view.tombstones.length === 0 ? (
            <GraveyardEmpty />
          ) : (
            <TombstoneGrid tombstones={view.tombstones} today={view.today} />
          )}
        </PendingDim>
      </GraveyardPendingProvider>
    </main>
  );
}
