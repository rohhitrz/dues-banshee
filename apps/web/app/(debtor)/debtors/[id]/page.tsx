import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { DraftCard } from "@/components/approvals/draft-card";
import { CandleTimeline } from "@/components/debtor/candle-timeline";
import { DebtorLoadError } from "@/components/debtor/debtor-load-error";
import { InvoicePanel } from "@/components/debtor/invoice-panel";
import { noticeMessage, type NoticeParams } from "@/lib/approvals/notices";
import { getDb } from "@/lib/db";
import { loadDebtorData, type DebtorLoadResult } from "@/lib/debtor/load";
import { formatDisplayDate } from "@/lib/graveyard/today";
import styles from "./debtor.module.css";

// The approvals actions rendered here (`redraftIn`) call the model, so this page needs the same limit as
// /approvals. Today is read from the clock per request: `auth()` and `searchParams` are dynamic APIs.
export const maxDuration = 300;

/** Never throws and never redirects: the page redirects and calls `notFound()` outside any `try`. */
async function load(
  supplierId: string,
  id: string,
  rawToday: string | string[] | undefined,
): Promise<DebtorLoadResult> {
  let handle: ReturnType<typeof getDb>;
  try {
    handle = getDb();
  } catch (err) {
    console.error("debtor: database unavailable", err);
    return { kind: "error", override: null };
  }
  try {
    return await loadDebtorData(handle.db, supplierId, id, Date.now(), rawToday);
  } finally {
    await handle.close().catch((err: unknown) => console.error("debtor: close failed", err));
  }
}

export default async function DebtorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<NoticeParams & { today?: string | string[] }>;
}) {
  // The supplier comes from the session only; nothing in the URL, query or body is consulted.
  const session = await auth();
  const supplierId = session?.supplierId;
  if (!supplierId) redirect("/signin");

  const { id } = await params;
  const query = await searchParams;

  const result = await load(supplierId, id, query.today);
  if (result.kind === "stale") redirect("/signin?error=SessionExpired");
  if (result.kind === "not_found") notFound();

  if (result.kind === "error") {
    return (
      <main className={styles.page}>
        <DebtorLoadError buyerId={id} override={result.override} />
      </main>
    );
  }

  const { view } = result;
  const override = view.override;
  const notice = noticeMessage(query);
  const returnTo = `/debtors/${view.buyerId}`;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{view.buyerName}</h1>
      {override === null ? null : <p className={styles.chip}>{`Demo date: ${formatDisplayDate(override)}`}</p>}

      {notice === null ? null : (
        <p role={notice.isError ? "alert" : "status"} className={notice.isError ? styles.error : styles.notice}>
          {notice.text}
        </p>
      )}

      {view.panels.length === 0 ? (
        <section className={styles.empty} aria-label="No invoices">
          <p className={styles.emptyText}>No invoices for this buyer on this date</p>
          <Link href="/" className={styles.link}>
            Back to the graveyard
          </Link>
        </section>
      ) : (
        <div className={styles.list}>
          {view.panels.map((panel) => (
            <InvoicePanel key={panel.panelId} panel={panel} today={view.today} />
          ))}
        </div>
      )}

      <section className={styles.section} aria-labelledby="waiting-heading">
        <h2 id="waiting-heading" className={styles.heading}>
          Waiting for your approval
        </h2>
        {view.drafts.length === 0 ? (
          <p className={styles.emptyText}>No drafts waiting for this buyer</p>
        ) : (
          <ul className={styles.list}>
            {view.drafts.map((item) => (
              <li key={item.draft.id}>
                <DraftCard item={item} override={override} returnTo={returnTo} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className={styles.heading}>
          Timeline
        </h2>
        <CandleTimeline entries={view.timeline} />
      </section>
    </main>
  );
}
