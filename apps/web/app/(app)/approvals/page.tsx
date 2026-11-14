import {
  SupplierNotFoundError,
  getSupplier,
  listPendingDrafts,
  type DraftWithContext,
  type Supplier,
} from "@dues-banshee/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DraftCard } from "@/components/approvals/draft-card";
import { SubmitButton } from "@/components/approvals/submit-button";
import { getDb } from "@/lib/db";
import { noticeMessage, type NoticeParams } from "@/lib/approvals/notices";
import { resolveSupplierToday } from "@/lib/approvals/supplier-today";
import { checkLadderNow } from "./actions";
import styles from "./approvals.module.css";

// `checkLadderNow` (one Ladder_Run: up to 20 Draft_Attempts x up to 3 model calls) and the redraft
// action run with the limit of the page that calls them, so the 300 seconds is set here.
export const maxDuration = 300;

type Loaded = { kind: "ok"; supplier: Supplier; drafts: DraftWithContext[] } | { kind: "stale" } | { kind: "error" };

/** Never throws and never redirects: the page redirects on `stale`, outside any `try`. */
async function load(supplierId: string): Promise<Loaded> {
  let handle: ReturnType<typeof getDb>;
  try {
    handle = getDb();
  } catch (err) {
    console.error("approvals: database unavailable", err);
    return { kind: "error" };
  }
  try {
    const supplier = await getSupplier(handle.db, supplierId);
    return { kind: "ok", supplier, drafts: await listPendingDrafts(handle.db, supplierId) };
  } catch (err) {
    if (err instanceof SupplierNotFoundError) return { kind: "stale" };
    console.error("approvals: load failed", err);
    return { kind: "error" };
  } finally {
    await handle.close().catch((err: unknown) => console.error("approvals: close failed", err));
  }
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<NoticeParams & { today?: string | string[] }>;
}) {
  // The supplier comes from the session only; nothing in the URL, query or body is consulted.
  const session = await auth();
  const supplierId = session?.supplierId;
  if (!supplierId) redirect("/signin");

  const params = await searchParams;
  const result = await load(supplierId);
  if (result.kind === "stale") redirect("/signin?error=SessionExpired");
  // Only the demo supplier may time-travel; when the supplier could not be loaded there is no override.
  const override =
    result.kind === "ok" ? resolveSupplierToday(result.supplier, Date.now(), params.today).override : null;

  const notice = noticeMessage(params);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Approvals</h1>
      <p className={styles.intro}>
        Drafts wait here until you approve them. Approving records your decision; nothing is sent from this
        page.
      </p>

      {notice === null ? null : (
        <p role={notice.isError ? "alert" : "status"} className={notice.isError ? styles.error : styles.notice}>
          {notice.text}
        </p>
      )}

      <form action={checkLadderNow} className={styles.check}>
        {override === null ? null : <input type="hidden" name="today" value={override} />}
        <SubmitButton className={styles.button} pendingLabel="Checking the ladder…">
          Check the ladder now
        </SubmitButton>
      </form>

      {result.kind === "error" ? (
        <p role="alert" className={styles.error}>
          Could not load your drafts. Try again in a moment.
        </p>
      ) : result.drafts.length === 0 ? (
        <section className={styles.empty} aria-label="No drafts">
          <p className={styles.emptyTitle}>No drafts waiting</p>
          <Link href="/" className={styles.link}>
            Back to the graveyard
          </Link>
        </section>
      ) : (
        <ul className={styles.list}>
          {result.drafts.map((item) => (
            <li key={item.draft.id}>
              <DraftCard item={item} override={override} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
