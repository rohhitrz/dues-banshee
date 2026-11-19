import { DISCLAIMER } from "@dues-banshee/agent";
import { findJoinableCall } from "@dues-banshee/db";
import { hashToken } from "@dues-banshee/voice";
import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { CallClient } from "./call-client";
import styles from "./call-page.module.css";

export const dynamic = "force-dynamic";

// The URL carries the Join_Token, so keep the page out of search indexes.
export const metadata: Metadata = { robots: { index: false } };

// Not exported: a Next.js page file may export only its page, `dynamic` and `metadata`.
const CALL_COPY = "AI call over the internet. Phone (PSTN) calls are on the roadmap.";
const RECORDING_LINE = "You will talk to an AI assistant. The call is recorded and transcribed.";
const EXPIRED_TEXT = "This call link has expired or was already used";

/**
 * The buyer's join page. Every invalid case (unknown, used, expired token) renders the same markup,
 * with no supplier, buyer or invoice data. A valid token shows only the supplier name.
 */
export default async function CallPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { db, close } = getDb();
  let call: Awaited<ReturnType<typeof findJoinableCall>>;
  try {
    call = await findJoinableCall(db, hashToken(token), new Date());
  } finally {
    await close().catch(() => console.error("call page: close failed"));
  }

  if (call === null) {
    return (
      <main className={styles.page}>
        <div className={styles.card}>
          <h1 className={styles.title}>Dues Banshee</h1>
          <p className={styles.expired}>{EXPIRED_TEXT}</p>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{call.supplierName}</h1>
        <p className={styles.notice}>{RECORDING_LINE}</p>
        <p className={styles.notice}>{CALL_COPY}</p>
        <CallClient token={token} />
        <p className={styles.disclaimer}>{DISCLAIMER}</p>
      </div>
    </main>
  );
}
