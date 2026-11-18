"use server";

import {
  createRazorpayClient,
  createTwilioSandbox,
  createWaMeLink,
  readChannelEnv,
  sendDraft,
  type SendOutcome,
} from "@dues-banshee/agent";
import {
  SupplierNotFoundError,
  getDraftForSupplier,
  getSupplier,
  type Db,
  type Supplier,
} from "@dues-banshee/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { resolveSupplierToday } from "@/lib/approvals/supplier-today";
import { outcomeMessage } from "@/lib/send/messages";

// No `maxDuration` here: a server action runs with the limit of the page that calls it, and the Debtor_Page
// exports 300 seconds, which is longer than a Twilio send (about 17 s at worst).

const STALE_URL = "/signin?error=SessionExpired";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `useActionState` holds for one Invoice_Panel. Only the WaMe_Link handoff carries a `url`. */
export interface SendView {
  invoiceId: string;
  text: string;
  role: "status" | "alert";
  url?: string;
}

type Channel = "twilio_sandbox" | "wa_me";

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

/** Outcomes after which a Message_Row, Pay_Link or Escalation_Event may have been written for this buyer. */
function wroteRow(outcome: SendOutcome): boolean {
  switch (outcome.kind) {
    case "sent":
    case "handed_off":
    case "channel_failed":
    case "too_long":
    case "record_failed":
      return true;
    default:
      return false;
  }
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
    await close().catch(() => console.error("send: close failed"));
  }
}

async function run(channel: Channel, form: FormData): Promise<SendView> {
  const supplierId = await sessionSupplierId();
  const draftId = field(form, "draftId");

  const outcome = await withSupplier(supplierId, async (db, supplier) => {
    const { today } = resolveSupplierToday(supplier, Date.now(), field(form, "today"));
    const env = readChannelEnv(process.env);

    let invoiceId = "";
    let buyerId: string | null = null;
    let result: SendOutcome;
    try {
      if (UUID.test(draftId)) {
        const found = await getDraftForSupplier(db, supplierId, draftId);
        if (found !== null) {
          invoiceId = found.draft.invoiceId;
          buyerId = found.buyerId;
        }
      }
      const fetchFn = globalThis.fetch;
      result = await sendDraft(
        {
          db,
          env,
          razorpay:
            env.razorpay === null
              ? null
              : createRazorpayClient({ fetch: fetchFn, keyId: env.razorpay.keyId, keySecret: env.razorpay.keySecret }),
          twilio:
            env.twilio === null
              ? null
              : createTwilioSandbox({
                  fetch: fetchFn,
                  accountSid: env.twilio.accountSid,
                  authToken: env.twilio.authToken,
                  from: env.twilio.from,
                }),
          waMe: createWaMeLink(),
        },
        { supplierId, draftId, today, channel },
      );
    } catch (err) {
      if (err instanceof SupplierNotFoundError) throw err;
      // Log the error name only: a driver or provider error message can carry a connection string or a number.
      console.error("send: unexpected failure", { draftId, channel }, err instanceof Error ? err.name : "unknown");
      result = { kind: "record_failed" };
    }

    if (buyerId !== null && wroteRow(result)) revalidatePath(`/debtors/${buyerId}`);

    const message = outcomeMessage(result, env.sandboxJoinCode);
    const view: SendView = { invoiceId, text: message.text, role: message.role };
    if (result.kind === "handed_off") view.url = result.url;
    return view;
  });
  if (outcome.stale) redirect(STALE_URL);
  return outcome.value;
}

/** Send the approved Draft with its Pay_Link through the Twilio_Sandbox. */
export async function sendPayLink(_prev: SendView | null, form: FormData): Promise<SendView> {
  return run("twilio_sandbox", form);
}

/** Build the same Outbound_Text and hand it to the owner as a wa.me link. */
export async function openInWhatsApp(_prev: SendView | null, form: FormData): Promise<SendView> {
  return run("wa_me", form);
}
