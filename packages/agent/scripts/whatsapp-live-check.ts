// Manual live check (Requirement 9.9). Not a test: it is outside the `test` script and the Vitest
// include globs (test/** only), and CI never runs it.
//
//   pnpm --filter @dues-banshee/agent exec tsx scripts/whatsapp-live-check.ts
//
// Needs Razorpay TEST-mode keys, a Twilio WhatsApp Sandbox sender, DATABASE_URL (read only) and
// DEMO_BUYER_WHATSAPP, a number that has joined the sandbox (`join <code>` sent from that phone).
//
// It builds the Sharma Traders Outbound_Text for the demo invoice (amount from the database, through the
// Engine's formatINR), looks for an existing Razorpay link first and creates one only when none exists
// (test mode allows 30 links), sends the text through the real Twilio_Sandbox channel and prints the
// message SID, the link URL and the last status poll. It writes nothing to the database. It never prints
// an env var value, and it prints the buyer number masked.
import { DEMO_SUPPLIER, createDb, findSupplierIdByUdyam, listLadderRecords } from "@dues-banshee/db";
import type { RuleId } from "@dues-banshee/engine";
import { buildOutboundText } from "../src/channel/outbound-text";
import { maskNumber } from "../src/channel/mask";
import { parseE164 } from "../src/channel/message-channel";
import type { PollRecord } from "../src/channel/message-channel";
import { readChannelEnv } from "../src/channel/env";
import { createRazorpayClient } from "../src/channel/razorpay";
import type { CreateLinkBody, PayLinkInfo } from "../src/channel/razorpay";
import { MAX_OUTBOUND_LENGTH } from "../src/channel/send-draft";
import { createTwilioSandbox } from "../src/channel/twilio-sandbox";

const SHARMA_INVOICE_NUMBER = "LPC/26-27/0412";
// Only the invoice amount is read; Today just satisfies the promise filter of listLadderRecords.
const TODAY = "2026-11-12";
const RULE_IDS: readonly RuleId[] = ["MSMED-15", "MSMED-16"];
const BODY_TEXT =
  "Namaste Sharma ji, invoice LPC/26-27/0412 ka bhugtan abhi baaki hai. " +
  "Kripya is hafte payment kar dein, taaki 31 March ke baad tax ka bojh na pade. Dhanyavaad.";
const REQUIRED_ENV = [
  "DATABASE_URL",
  "DEMO_BUYER_WHATSAPP",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_WHATSAPP_FROM",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
] as const;

/** Names (never values) of the required variables that are unset or blank. */
function missingVariables(): string[] {
  return REQUIRED_ENV.filter((name) => (process.env[name] ?? "").trim() === "");
}

/** The last status poll, as text: `status (error code)` or the poll error kind. */
function describePoll(poll: PollRecord | undefined): string {
  if (poll === undefined) return "no status poll ran";
  if ("error" in poll) return `poll error: ${poll.error}${poll.httpStatus === null ? "" : ` (HTTP ${poll.httpStatus})`}`;
  return `${poll.status}${poll.errorCode === "" ? "" : ` (error code ${poll.errorCode})`}`;
}

async function main(): Promise<number> {
  const missing = missingVariables();
  if (missing.length > 0) {
    console.error(`whatsapp-live-check: missing required environment variable(s): ${missing.join(", ")}`);
    console.error("Set them locally (for example in your shell) and run again. Nothing was called or written.");
    return 1;
  }

  const rawKeyId = (process.env["RAZORPAY_KEY_ID"] ?? "").trim();
  if (!rawKeyId.startsWith("rzp_test_")) {
    console.error("whatsapp-live-check: RAZORPAY_KEY_ID must be a test-mode key id (rzp_test_...). Refusing to run.");
    return 1;
  }
  const buyerNumber = parseE164((process.env["DEMO_BUYER_WHATSAPP"] ?? "").trim());
  if (buyerNumber === null) {
    console.error("whatsapp-live-check: DEMO_BUYER_WHATSAPP must be an E.164 number such as +<country code><number>.");
    return 1;
  }
  const env = readChannelEnv(process.env);
  if (env.twilio === null) {
    console.error("whatsapp-live-check: TWILIO_WHATSAPP_FROM must be an E.164 number without the whatsapp: prefix.");
    return 1;
  }
  if (env.razorpay === null) {
    console.error("whatsapp-live-check: the Razorpay keys are not usable (test-mode key id and secret are required).");
    return 1;
  }

  // Reads only: the amount of the Sharma Traders invoice comes from the database, never from this script.
  const { db, close } = createDb((process.env["DATABASE_URL"] ?? "").trim());
  let invoiceId: string;
  let amountPaise: number;
  try {
    const supplierId = await findSupplierIdByUdyam(db, DEMO_SUPPLIER.udyamNumber);
    if (supplierId === null) {
      console.error("whatsapp-live-check: demo supplier not found. Seed the demo data first (pnpm --filter @dues-banshee/db db:seed).");
      return 1;
    }
    const records = await listLadderRecords(db, supplierId, TODAY);
    const record = records.find((r) => r.invoiceNumber === SHARMA_INVOICE_NUMBER);
    if (record === undefined) {
      console.error(`whatsapp-live-check: invoice ${SHARMA_INVOICE_NUMBER} (Sharma Traders) not found for the demo supplier.`);
      return 1;
    }
    invoiceId = record.invoice.id;
    amountPaise = record.invoice.amountPaise;
  } finally {
    await close();
  }

  const razorpay = createRazorpayClient({
    fetch: globalThis.fetch,
    keyId: env.razorpay.keyId,
    keySecret: env.razorpay.keySecret,
  });

  // The link's reference id is the invoice id here (36 characters, within Razorpay's 40), because the
  // live check has no Draft row. A rerun finds the link made by the previous run.
  const referenceId = invoiceId;
  const found = await razorpay.findByReference(referenceId);
  if (!found.ok) {
    console.error(`whatsapp-live-check: Razorpay lookup failed (${found.errorKind}, HTTP ${found.httpStatus ?? "none"}).`);
    return 1;
  }
  let link: PayLinkInfo;
  if (found.value !== null) {
    link = found.value;
    console.log("Razorpay link: reusing the existing test link for this invoice.");
  } else {
    const body: CreateLinkBody = {
      amount: amountPaise,
      currency: "INR",
      accept_partial: false,
      reference_id: referenceId,
      notes: { invoice_id: invoiceId },
      notify: { sms: false, email: false },
    };
    const created = await razorpay.create(body);
    if (!created.ok) {
      console.error(`whatsapp-live-check: Razorpay create failed (${created.errorKind}, HTTP ${created.httpStatus ?? "none"}).`);
      return 1;
    }
    link = created.value;
    console.log("Razorpay link: created a new test link.");
  }

  const built = buildOutboundText({ body: BODY_TEXT, ruleIds: RULE_IDS, url: link.url, amountPaise });
  if (!built.ok) {
    console.error("whatsapp-live-check: the Outbound_Text could not be built.");
    return 1;
  }
  if (built.text.length > MAX_OUTBOUND_LENGTH) {
    console.error(`whatsapp-live-check: the Outbound_Text is ${built.text.length} characters, over the ${MAX_OUTBOUND_LENGTH} limit.`);
    return 1;
  }

  console.log(`Sending to ${maskNumber(buyerNumber)} through the Twilio WhatsApp Sandbox. Status polls take up to about 4 seconds...`);
  const twilio = createTwilioSandbox({
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    accountSid: env.twilio.accountSid,
    authToken: env.twilio.authToken,
    from: env.twilio.from,
  });
  const result = await twilio.send({ to: buyerNumber, text: built.text, idempotencyKey: referenceId });

  console.log(`\nPayment link URL: ${link.url}`);
  if (result.kind === "sent") {
    console.log(`Twilio message SID: ${result.providerMessageId}`);
    console.log(`Final polled status: ${describePoll(result.polls[result.polls.length - 1])}`);
    console.log("\nCheck the phone: the message should show the text and the payment link.");
    console.log("Nothing was written to the database.");
    return 0;
  }
  if (result.kind === "failed") {
    console.log(`Twilio message SID: ${result.providerMessageId ?? "none (the create call failed)"}`);
    console.log(`Final polled status: ${describePoll(result.polls[result.polls.length - 1])}`);
    console.error(`\nResult: FAILED (${result.errorKind}${result.errorCode === "" ? "" : `, code ${result.errorCode}`}).`);
    if (result.errorKind === "sandbox_window") {
      console.error("The number has not joined the sandbox, or its 24-hour window is closed. Send the join code from that phone and retry.");
    }
    console.error("Nothing was written to the database.");
    return 1;
  }
  console.error("whatsapp-live-check: unexpected channel result.");
  return 1;
}

process.exitCode = await main();
