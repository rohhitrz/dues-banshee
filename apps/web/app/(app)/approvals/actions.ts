"use server";

import {
  approveDraft,
  editDraft,
  productionModels,
  redraft,
  rejectDraft,
  runLadder,
  type DecideResult,
  type DraftLanguage,
} from "@dues-banshee/agent";
import { SupplierNotFoundError, getSupplier, type Db } from "@dues-banshee/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { decisionLabelKey, type NoticeCode } from "@/lib/approvals/notices";
import { resolveToday } from "@/lib/graveyard/today";

// This file sets no `maxDuration`: a server action runs with the limit of the page that calls it, and
// `approvals/page.tsx` exports 300 seconds for `checkLadderNow` (and the LLM-backed redraft).

const STALE_URL = "/signin?error=SessionExpired";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Notice {
  code: NoticeCode;
  label?: string;
  n?: number;
}

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

/** The form's `today` goes through the same validation as `?today=` on the page. */
function resolveFormToday(form: FormData) {
  return resolveToday(Date.now(), field(form, "today"));
}

type Scoped<T> = { stale: true } | { stale: false; value: T };

/**
 * Runs `fn` against the database for the session supplier. A supplier that no longer exists (stale
 * session) comes back as `{ stale: true }`; the caller redirects outside any `try`.
 */
async function withSupplier<T>(supplierId: string, fn: (db: Db) => Promise<T>): Promise<Scoped<T>> {
  const { db, close } = getDb();
  try {
    await getSupplier(db, supplierId);
    return { stale: false, value: await fn(db) };
  } catch (err) {
    if (err instanceof SupplierNotFoundError) return { stale: true };
    throw err;
  } finally {
    await close().catch((err: unknown) => console.error("approvals: close failed", err));
  }
}

/** Back to the queue with one fixed message, keeping a valid `?today=` override. */
function finish(notice: Notice, override: string | null): never {
  revalidatePath("/approvals");
  const params = new URLSearchParams();
  if (override !== null) params.set("today", override);
  params.set("notice", notice.code);
  if (notice.label !== undefined) params.set("label", notice.label);
  if (notice.n !== undefined) params.set("n", String(notice.n));
  redirect(`/approvals?${params.toString()}`);
}

function noticeFor(result: DecideResult, success: NoticeCode): Notice {
  switch (result.kind) {
    case "ok":
      return { code: success };
    case "expired":
      return { code: "expired", label: decisionLabelKey(result.decision) };
    default:
      return { code: result.kind };
  }
}

/** Shared by approve, saveEdit, reject and redraftIn: one decision on one Draft of the session supplier. */
async function decide(
  form: FormData,
  success: NoticeCode,
  run: (db: Db, supplierId: string, draftId: string, today: string) => Promise<DecideResult>,
): Promise<never> {
  const supplierId = await sessionSupplierId();
  const { today, override } = resolveFormToday(form);
  const draftId = field(form, "draftId");
  if (!UUID.test(draftId)) return finish({ code: "not_found" }, override);

  const outcome = await withSupplier(supplierId, (db) => run(db, supplierId, draftId, today));
  if (outcome.stale) redirect(STALE_URL);
  return finish(noticeFor(outcome.value, success), override);
}

export async function approve(form: FormData): Promise<void> {
  await decide(form, "approved", (db, supplierId, draftId, today) =>
    approveDraft({ db }, supplierId, draftId, today),
  );
}

/** Only the Body_Text is editable; the Basis_Line and Disclaimer are rebuilt by the agent. */
export async function saveEdit(form: FormData): Promise<void> {
  const body = field(form, "body");
  await decide(form, "saved", (db, supplierId, draftId, today) =>
    editDraft({ db }, supplierId, draftId, body, today),
  );
}

export async function reject(form: FormData): Promise<void> {
  const reason = field(form, "reason").trim();
  await decide(form, "rejected", (db, supplierId, draftId, today) =>
    rejectDraft({ db }, supplierId, draftId, reason === "" ? null : reason, today),
  );
}

function toLanguage(value: string): DraftLanguage | null {
  return value === "english" || value === "hinglish" ? value : null;
}

export async function redraftIn(form: FormData): Promise<void> {
  const language = toLanguage(field(form, "language"));
  if (language === null) {
    await sessionSupplierId();
    return finish({ code: "draft_failed" }, resolveFormToday(form).override);
  }
  await decide(form, "redrafted", (db, supplierId, draftId, today) =>
    redraft({ db, models: productionModels() }, supplierId, draftId, language, today),
  );
}

/** One Ladder_Run for the session supplier only. */
export async function checkLadderNow(form: FormData): Promise<void> {
  const supplierId = await sessionSupplierId();
  const { today, override } = resolveFormToday(form);

  const outcome = await withSupplier(supplierId, async (db): Promise<Notice> => {
    try {
      const result = await runLadder({ db, models: productionModels() }, supplierId, today);
      const n = Object.values(result.invoices).filter((o) => o.kind === "drafted").length;
      return { code: "ladder_checked", n };
    } catch (err) {
      if (err instanceof SupplierNotFoundError) throw err;
      console.error("approvals: ladder run failed", { supplierId, today }, err);
      return { code: "ladder_failed" };
    }
  });
  if (outcome.stale) redirect(STALE_URL);
  return finish(outcome.value, override);
}
