import { DISCLAIMER, createWaMeLink } from "@dues-banshee/agent";
import {
  countStartedCalls,
  createVoiceCall,
  findInvoiceForCall,
  getDebtorData,
  logToolCall,
  type Db,
  type Supplier,
} from "@dues-banshee/db";
import {
  buyerAddress,
  generateJoinToken,
  hashToken,
  inCallWindow,
  istDayBounds,
} from "@dues-banshee/voice";
import { istDate } from "../graveyard/today";
import { resolveSupplierToday } from "../approvals/supplier-today";
import { buildDebtorView } from "../debtor/build-debtor-view";
import {
  REFUSAL_TEXT,
  isCallableInvoice,
  isDemoSupplier,
  startCallRefusal,
  type StartCallRefusalKind,
} from "./callable";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;

export const CALL_LINK_READY_TEXT = "Call link ready. Link works once, for 10 minutes.";
export const NO_ORIGIN_TEXT = "Could not build the call link. Please try again.";

/** What `useActionState` holds for one Invoice_Panel after "Start call". */
export interface StartCallView {
  invoiceId: string;
  text: string;
  role: "status" | "alert";
  /** Only on success: `<origin>/call/<Join_Token>`. Shown once; the token is stored only as a hash. */
  callUrl?: string;
  /** Only on success: the WaMe_Link whose text holds `callUrl`. */
  waMeUrl?: string;
}

/**
 * The origin of the owner's request: the `Origin` header when it parses as an http(s) origin, else
 * `x-forwarded-proto` + `host`. `null` when neither gives a usable origin.
 */
export function requestOrigin(headers: { get(name: string): string | null }): string | null {
  const origin = headers.get("origin");
  if (origin !== null) {
    try {
      const url = new URL(origin);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // Not a URL (for example the literal "null"): fall through to the forwarded headers.
    }
  }
  const host = headers.get("host");
  if (host === null || !HOST.test(host)) return null;
  const proto = (headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  if (proto === "http" || proto === "https") return `${proto}://${host}`;
  if (proto === "") return `http://${host}`;
  return null;
}

export interface StartCallDeps {
  db: Db;
  supplier: Supplier;
  /** The real clock instant. The Call_Window and the Call_Day use it; the Demo_Override does not. */
  now: Date;
  origin: string | null;
  /** `OPENAI_API_KEY` is set and not empty. */
  apiKeyConfigured: boolean;
}

function outboundText(d: { buyerName: string; supplierName: string; invoiceNumber: string; callUrl: string }): string {
  return [
    `Namaste ${buyerAddress(d.buyerName)}, ${d.supplierName} ki taraf se invoice ${d.invoiceNumber} ke baare mein ` +
      "ek chhoti AI call ke liye yeh link kholiye (ek baar chalega, 10 minute valid):",
    d.callUrl,
    "",
    DISCLAIMER,
  ].join("\n");
}

/**
 * The start-call logic. Takes the supplier (already read from the session) and an injected `now`, so a
 * test fixes the instant without a server action ever accepting one from a client. Reads only the invoice
 * id and the optional Demo_Override `today` from the form values.
 *
 * Order: Today → invoice (supplier-scoped) → Callable_Invoice from the Debtor_View → refusals (Req 1 C13)
 * → `createVoiceCall` → links → one `start_voice_call` Tool_Log row for every request that resolved to the
 * supplier's invoice. The row holds no Join_Token and no call URL.
 */
export async function startCallCore(
  deps: StartCallDeps,
  form: { invoiceId: string; today: string },
): Promise<StartCallView> {
  const { db, supplier, now } = deps;
  const nowMs = now.getTime();
  const echoId = UUID.test(form.invoiceId) ? form.invoiceId : "";
  const { today, override } = resolveSupplierToday(supplier, nowMs, form.today);

  const invoice = await findInvoiceForCall(db, supplier.id, form.invoiceId);
  if (invoice === null) {
    // Not found, non-uuid or another supplier's invoice: no row, no Tool_Log.
    return { invoiceId: echoId, text: REFUSAL_TEXT.not_found, role: "alert" };
  }

  const isDemo = isDemoSupplier(supplier);
  const callDay = istDate(nowMs);

  // Callability comes from the same Debtor_View the page shows, so the two can never disagree.
  let callable = false;
  if (deps.apiKeyConfigured) {
    const data = await getDebtorData(db, supplier.id, invoice.buyerId, today);
    if (data !== null) {
      const view = buildDebtorView({ supplier, data, bankRate: null, drafts: [], today, override });
      const panel = view.panels.find((p) => p.tombstone.id === invoice.invoiceId);
      callable = panel !== undefined && isCallableInvoice(panel.tombstone, today);
    }
  }

  let buyerCallsToday = 0;
  let demoCallsToday = 0;
  if (deps.apiKeyConfigured && callable) {
    const bounds = istDayBounds(callDay);
    if (isDemo) demoCallsToday = await countStartedCalls(db, { supplierId: supplier.id }, bounds);
    else buyerCallsToday = await countStartedCalls(db, { supplierId: supplier.id, buyerId: invoice.buyerId }, bounds);
  }

  const toolInput = { invoice_id: invoice.invoiceId, today, demo_override: override };
  const refuse = async (kind: StartCallRefusalKind | "no_origin", text: string): Promise<StartCallView> => {
    await logToolCall(db, {
      tool: "start_voice_call",
      invoiceId: invoice.invoiceId,
      input: toolInput,
      output: { ok: false, refusal: kind },
    });
    return { invoiceId: invoice.invoiceId, text, role: "alert" };
  };

  const refusal = startCallRefusal({
    found: true,
    configured: deps.apiKeyConfigured,
    callable,
    isDemo,
    inWindow: inCallWindow(nowMs),
    buyerCallsToday,
    demoCallsToday,
  });
  if (refusal !== null) return refuse(refusal, REFUSAL_TEXT[refusal]);
  if (deps.origin === null) return refuse("no_origin", NO_ORIGIN_TEXT);

  const token = generateJoinToken();
  const created = await createVoiceCall(db, {
    supplierId: supplier.id,
    invoiceId: invoice.invoiceId,
    callToday: today,
    tokenHash: hashToken(token),
    now,
  });
  if (created === null) return { invoiceId: echoId, text: REFUSAL_TEXT.not_found, role: "alert" };

  const callUrl = `${deps.origin}/call/${token}`;
  const handoff = await createWaMeLink().send({
    to: null,
    text: outboundText({
      buyerName: invoice.buyerName,
      supplierName: invoice.supplierName,
      invoiceNumber: invoice.invoiceNumber,
      callUrl,
    }),
    idempotencyKey: created.voiceCallId,
  });

  await logToolCall(db, {
    tool: "start_voice_call",
    invoiceId: invoice.invoiceId,
    input: toolInput,
    output: {
      ok: true,
      voice_call_id: created.voiceCallId,
      call_today: today,
      token_expires_at: created.tokenExpiresAt.toISOString(),
    },
  });

  const view: StartCallView = {
    invoiceId: invoice.invoiceId,
    text: CALL_LINK_READY_TEXT,
    role: "status",
    callUrl,
  };
  if (handoff.kind === "handoff") view.waMeUrl = handoff.url;
  return view;
}
