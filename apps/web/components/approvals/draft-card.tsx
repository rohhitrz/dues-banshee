import type { DraftWithContext } from "@dues-banshee/db";
import { approve, redraftIn, reject, saveEdit } from "@/app/(app)/approvals/actions";
import { STEP_TEXT } from "@/lib/graveyard/labels";
import { GuardedForm } from "./guarded-form";
import { SubmitButton } from "./submit-button";
import styles from "./draft-card.module.css";

export const NEEDS_APPROVAL_TEXT = "Needs your approval";
export const CAVEAT_BADGE_TEXT = "Registered on Udyam after supply: claim may be contested";

export interface DraftCardProps {
  item: DraftWithContext;
  /** The accepted `?today=` value, passed back with every action; null when Today is the real date. */
  override: string | null;
}

/** Steps 4 and 5 attach a PDF Document the owner can download. */
function hasDocument(step: DraftWithContext["draft"]["step"]): boolean {
  return step === "legal_notice" || step === "odr_pack";
}

function HiddenFields({ draftId, override }: { draftId: string; override: string | null }) {
  return (
    <>
      <input type="hidden" name="draftId" value={draftId} />
      {override === null ? null : <input type="hidden" name="today" value={override} />}
    </>
  );
}

/**
 * One pending Draft. Only the Body_Text is editable; the Basis_Line and Disclaimer in the Final_Text are
 * rebuilt by the server. Approving records the owner's decision and sends nothing.
 */
export function DraftCard({ item, override }: DraftCardProps) {
  const { draft, buyerName, invoiceNumber } = item;
  const caveat = draft.decision.action === "advance" && draft.decision.caveat === "registered_after_supply";
  const headingId = `draft-${draft.id}`;

  return (
    <article className={styles.card} aria-labelledby={headingId}>
      <header className={styles.header}>
        <h2 id={headingId} className={styles.buyer}>
          {buyerName}
        </h2>
        <p className={styles.meta}>
          <span className={styles.figure}>{invoiceNumber}</span>
          <span aria-hidden="true"> · </span>
          <span>{STEP_TEXT[draft.step]}</span>
        </p>
        <p className={styles.marker}>{NEEDS_APPROVAL_TEXT}</p>
        {caveat ? <p className={styles.caveat}>{CAVEAT_BADGE_TEXT}</p> : null}
      </header>

      <section aria-label="Message as it will be sent">
        <pre className={styles.finalText}>{draft.finalText}</pre>
      </section>

      <dl className={styles.facts}>
        <div>
          <dt>Rule IDs</dt>
          <dd className={styles.figure}>{draft.ruleIds.join(", ")}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className={styles.figure}>{draft.modelId}</dd>
        </div>
      </dl>

      {hasDocument(draft.step) ? (
        <p>
          <a className={styles.download} href={`/api/drafts/${draft.id}/document`}>
            Download the document (PDF)
          </a>
        </p>
      ) : null}

      <GuardedForm action={saveEdit} className={styles.editForm}>
        <HiddenFields draftId={draft.id} override={override} />
        <label className={styles.label} htmlFor={`body-${draft.id}`}>
          Edit the message
        </label>
        <textarea
          id={`body-${draft.id}`}
          name="body"
          className={styles.textarea}
          defaultValue={draft.bodyText}
          rows={8}
        />
        <p className={styles.hint}>Only the message can be edited. The basis line and disclaimer are added for you.</p>
        <SubmitButton className={styles.button} pendingLabel="Saving…">
          Save edit
        </SubmitButton>
      </GuardedForm>

      <div className={styles.actions}>
        <GuardedForm action={approve}>
          <HiddenFields draftId={draft.id} override={override} />
          <SubmitButton className={styles.primary} pendingLabel="Approving…">
            Approve
          </SubmitButton>
        </GuardedForm>

        <GuardedForm action={redraftIn} className={styles.redraft}>
          <HiddenFields draftId={draft.id} override={override} />
          <SubmitButton className={styles.button} name="language" value="english" pendingLabel="Redrafting…">
            Redraft in English
          </SubmitButton>
          <SubmitButton className={styles.button} name="language" value="hinglish" pendingLabel="Redrafting…">
            Redraft in Hinglish
          </SubmitButton>
        </GuardedForm>

        <GuardedForm action={reject} className={styles.reject}>
          <HiddenFields draftId={draft.id} override={override} />
          <label className={styles.label} htmlFor={`reason-${draft.id}`}>
            Reason (optional)
          </label>
          <input id={`reason-${draft.id}`} name="reason" type="text" className={styles.input} maxLength={500} />
          <SubmitButton className={styles.danger} pendingLabel="Rejecting…">
            Reject
          </SubmitButton>
        </GuardedForm>
      </div>
    </article>
  );
}
