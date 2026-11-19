// Shared setup for the handler tests: the Demo_Seed on PGlite plus helpers that build one Voice_Call for
// Sharma Traders (LPC/26-27/0412) at call_today 2026-11-12. Every time is injected; nothing reads the clock.
import {
  DEMO_SUPPLIER,
  agentRuns,
  createVoiceCall,
  findSupplierIdByUdyam,
  invoices,
  promises,
  seed,
  voiceCalls,
  voiceToolCalls,
  voiceTranscriptLines,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { afterAll, afterEach, beforeAll } from "vitest";
import { generateJoinToken, handleEnd, handleTranscript, hashToken, runCallTool } from "../../src/index";

/** 2026-11-12 10:30 IST. `started_at` of every live call, and the Demo_Seed Today. */
export const NOW = new Date("2026-11-12T05:00:00.000Z");
/** The instant `seconds` after `started_at`. */
export const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

export const SHARMA_INVOICE_NUMBER = "LPC/26-27/0412";
export const SHARMA_FACTS = {
  buyer_name: "Sharma Traders",
  supplier_name: "Laxmi Precision Components (Demo)",
  invoice_number: "LPC/26-27/0412",
  principal: "₹4,12,000",
  due_date: "17 Oct 2026",
  due_rule_ids: ["MSMED-15"],
  days_overdue: 26,
  interest: "₹5,127.94",
  interest_rule_ids: ["MSMED-16"],
  total_due: "₹4,17,127.94",
  tax_bomb_date: "31 Mar 2027",
  tax_bomb_days_left: 139,
  tax_bomb_rule_ids: ["IT-43BH"],
} as const;

export const promiseArgs = (amountPaise: number, dateIso: string, spokenText = "haan, pakka"): string =>
  JSON.stringify({ amount_paise: amountPaise, date_iso: dateIso, spoken_text: spokenText });

/**
 * Registers the template database hooks in the calling `describe` / file and returns the factory for
 * live calls. Call it once at the top of a test file.
 */
export function useCallWorld() {
  let template: TestDb;
  const open: TestDb[] = [];

  beforeAll(async () => {
    template = await createTestDb();
    await seed(template.db);
  });
  afterAll(async () => {
    await template.close();
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((t) => t.close()));
  });

  /** One Voice_Call of Sharma Traders. `live` (default) is joined at `NOW`; `created` is not joined. */
  async function call(status: "live" | "created" = "live") {
    const t = await cloneTestDb(template);
    open.push(t);
    const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
    const all = await t.db.select({ id: invoices.id, n: invoices.invoiceNumber }).from(invoices);
    const sharma = all.find((i) => i.n === SHARMA_INVOICE_NUMBER);
    const other = all.find((i) => i.n !== SHARMA_INVOICE_NUMBER);
    if (supplierId === null || sharma === undefined || other === undefined) {
      throw new Error("test setup: demo seed missing");
    }
    const token = generateJoinToken();
    const created = await createVoiceCall(t.db, {
      supplierId,
      invoiceId: sharma.id,
      callToday: "2026-11-12",
      tokenHash: hashToken(token),
      now: NOW,
    });
    if (created === null) throw new Error("test setup: createVoiceCall returned null");
    const id = created.voiceCallId;
    if (status === "live") {
      await t.pglite.query(`UPDATE voice_calls SET status = 'live', started_at = $2 WHERE id = $1`, [
        id,
        NOW.toISOString(),
      ]);
    }

    const tool = (name: string, args: string, callId: string, when: Date = NOW, withToken: string = token) =>
      runCallTool({ db: t.db, now: when }, { voiceCallId: id, token: withToken, callId, name, arguments: args });
    const end = (when: Date = NOW, withToken: string = token) =>
      handleEnd({ db: t.db, now: when }, { voiceCallId: id, token: withToken });
    const transcript = (
      itemId: string,
      text: string,
      when: Date = NOW,
      speaker: "buyer" | "agent" = "buyer",
      withToken: string = token,
    ) => handleTranscript({ db: t.db, now: when }, { voiceCallId: id, token: withToken, itemId, speaker, text });

    const row = async () => {
      const r = (await t.db.select().from(voiceCalls)).find((c) => c.id === id);
      if (r === undefined) throw new Error("test setup: voice call row missing");
      return r;
    };
    const promiseRows = () => t.db.select().from(promises);
    const voicePromises = async () => (await promiseRows()).filter((p) => p.source === "voice");
    const toolLog = () => t.db.select().from(agentRuns);
    const toolCallRows = () => t.db.select().from(voiceToolCalls);
    const lines = () => t.db.select().from(voiceTranscriptLines);

    return {
      t,
      id,
      token,
      buyerId: created.buyerId,
      sharmaInvoiceId: sharma.id,
      otherInvoiceId: other.id,
      tool,
      end,
      transcript,
      row,
      promiseRows,
      voicePromises,
      toolLog,
      toolCallRows,
      lines,
    };
  }

  return { call };
}
