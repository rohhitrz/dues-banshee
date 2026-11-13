import { DEMO_SUPPLIER, findSupplierIdByUdyam, seed, suppliers } from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DATA_ROWS, MAX_UPLOAD_BYTES, MULTIPART_OVERHEAD_BYTES, uploadTooLargeMessage } from "@/lib/import/limits";

// `vi.mock` is hoisted above the imports, so the mocks' state has to be hoisted with it.
const mocks = vi.hoisted(() => ({
  current: undefined as unknown,
  close: undefined as unknown as ReturnType<typeof vi.fn>,
  auth: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/db", () => {
  mocks.close = vi.fn(async () => {});
  return {
    getDb: () => ({ db: (mocks.current as TestDb).db, close: mocks.close }),
  };
});

vi.mock("@/auth", () => {
  mocks.auth = vi.fn();
  return { auth: mocks.auth };
});

import { POST as commit } from "@/app/api/import/commit/route";
import { POST as preview } from "@/app/api/import/preview/route";

const HEADER = "Invoice No,Party Name,Amount,Invoice Date,Credit Days";
const SHARMA_ROW = (amount: string) => `LPC/26-27/0412,Sharma Traders,"${amount}",02/09/2026,45`;
const NEW_ROW = "LPC/26-27/0999,Patel Metals,\"₹1,00,000\",02/09/2026,45";

interface PreviewBody {
  counts: { new: number; already_imported: number; error: number };
  rows: { status: string; warnings: string[] }[];
}

let template: TestDb;
let seeded: TestDb;
let clone: TestDb;
let supplierId: string;

beforeAll(async () => {
  template = await createTestDb();
  seeded = await cloneTestDb(template);
  await seed(seeded.db);
});

afterAll(async () => {
  await seeded.close();
  await template.close();
});

beforeEach(async () => {
  clone = await cloneTestDb(seeded);
  mocks.current = clone;
  const id = await findSupplierIdByUdyam(clone.db, DEMO_SUPPLIER.udyamNumber);
  if (!id) throw new Error("demo supplier missing after seed");
  supplierId = id;
  mocks.auth.mockResolvedValue({ supplierId, expires: "2999-01-01T00:00:00.000Z" });
});

afterEach(async () => {
  mocks.close.mockClear();
  mocks.auth.mockReset();
  await clone.close();
});

const csv = (...rows: string[]): string => [HEADER, ...rows].join("\n");

function formWith(text: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("file", new File([text], "ledger.csv", { type: "text/csv" }));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const post = (route: string, form: FormData, headers: Record<string, string> = {}): Request =>
  new Request(`http://localhost/api/import/${route}`, { method: "POST", body: form, headers });

const previewBody = async (text: string): Promise<PreviewBody> => {
  const res = await preview(post("preview", formWith(text)));
  expect(res.status).toBe(200);
  return (await res.json()) as PreviewBody;
};

async function count(table: "invoices" | "buyers"): Promise<number> {
  const result = await clone.pglite.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return result.rows[0]?.n ?? -1;
}

async function invoiceCountFor(id: string): Promise<number> {
  const result = await clone.pglite.query<{ n: number }>(
    "select count(*)::int as n from invoices where supplier_id = $1",
    [id],
  );
  return result.rows[0]?.n ?? -1;
}

describe("import routes: session (Requirement 12.5)", () => {
  it("returns 401 from preview and commit without a session, and writes nothing", async () => {
    mocks.auth.mockResolvedValue(null);
    const before = await count("invoices");

    const previewRes = await preview(post("preview", formWith(csv(NEW_ROW))));
    const commitRes = await commit(post("commit", formWith(csv(NEW_ROW))));

    expect(previewRes.status).toBe(401);
    expect(commitRes.status).toBe(401);
    expect(await count("invoices")).toBe(before);
    expect(mocks.close).not.toHaveBeenCalled();
  });
});

describe("import routes: stored invoices (Requirements 10.5, 10.6, 10.7)", () => {
  it("marks the seeded Sharma invoice already_imported with no warning", async () => {
    const body = await previewBody(csv(SHARMA_ROW("₹4,12,000")));

    expect(body.counts).toEqual({ new: 0, already_imported: 1, error: 0 });
    expect(body.rows[0]?.status).toBe("already_imported");
    expect(body.rows[0]?.warnings).toEqual([]);
  });

  it("warns about a differing amount in preview, and commit leaves the stored amount alone", async () => {
    const text = csv(SHARMA_ROW("₹4,15,000"));

    const body = await previewBody(text);
    expect(body.rows[0]?.status).toBe("already_imported");
    expect(body.rows[0]?.warnings).toContain("Differs from stored invoice: amount");

    const res = await commit(post("commit", formWith(text)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 0, skipped: 1 });

    const stored = await clone.pglite.query<{ amount_paise: number }>(
      "select amount_paise from invoices where invoice_number = $1",
      ["LPC/26-27/0412"],
    );
    expect(stored.rows).toEqual([{ amount_paise: 41_200_000 }]);
  });

  it("inserts a new invoice once, and a second commit skips it (Requirement 10.9)", async () => {
    const text = csv(NEW_ROW);
    const before = await count("invoices");

    const body = await previewBody(text);
    expect(body.counts).toEqual({ new: 1, already_imported: 0, error: 0 });
    expect(body.rows[0]?.status).toBe("new");

    const first = await commit(post("commit", formWith(text)));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ inserted: 1, skipped: 0, errors: 0 });
    expect(await count("invoices")).toBe(before + 1);

    const second = await commit(post("commit", formWith(text)));
    expect(await second.json()).toEqual({ inserted: 0, skipped: 1, errors: 0 });
    expect(await count("invoices")).toBe(before + 1);

    // One preview and two commits, each closing its database client.
    expect(mocks.close).toHaveBeenCalledTimes(3);
  });
});

describe("import routes: supplier comes from the session (Requirement 13.7)", () => {
  it("ignores a supplierId in the form data", async () => {
    const [other] = await clone.db
      .insert(suppliers)
      .values({
        name: "Other Supplier",
        udyamNumber: "UDYAM-MH-00-0000001",
        supplierCategory: "micro",
        supplierActivity: "manufacturing",
      })
      .returning({ id: suppliers.id });
    if (!other) throw new Error("second supplier was not inserted");
    const before = await invoiceCountFor(supplierId);

    const res = await commit(post("commit", formWith(csv(NEW_ROW), { supplierId: other.id })));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 1, skipped: 0 });
    expect(await invoiceCountFor(supplierId)).toBe(before + 1);
    expect(await invoiceCountFor(other.id)).toBe(0);
  });
});

describe("import routes: size and row limits (Requirements 13.2, 13.5)", () => {
  it("returns 413 for an oversized Content-Length without reading the body", async () => {
    const length = String(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES + 1);

    for (const [name, route] of [
      ["preview", preview],
      ["commit", commit],
    ] as const) {
      const request = post(name, formWith(csv(NEW_ROW)), { "content-length": length });
      const formData = vi.spyOn(request, "formData");

      const res = await route(request);

      expect(res.status).toBe(413);
      expect(formData).not.toHaveBeenCalled();
      expect(request.bodyUsed).toBe(false);
    }
    expect(mocks.close).not.toHaveBeenCalled();
  });

  // A streamed body has no Content-Length, so only the byte-counting read can enforce the limit.
  async function streamed(route: string, form: FormData): Promise<Request> {
    const source = new Response(form);
    const bytes = new Uint8Array(await source.arrayBuffer());
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 16 * 1024) controller.enqueue(bytes.subarray(i, i + 16 * 1024));
        controller.close();
      },
    });
    const request = new Request(`http://localhost/api/import/${route}`, {
      method: "POST",
      body,
      headers: { "content-type": source.headers.get("content-type") ?? "" },
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    return request;
  }
  const big = "x".repeat(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES + 1024);
  for (const [name, route] of [
    ["preview", preview],
    ["commit", commit],
  ] as const) {
    it(`${name}: returns 413 for an oversized body with no Content-Length`, async () => {
      expect((await route(await streamed(name, formWith(big)))).status).toBe(413);
    });
    it(`${name}: returns 413 for a small file plus a large text field with no Content-Length`, async () => {
      expect((await route(await streamed(name, formWith(csv(NEW_ROW), { note: big })))).status).toBe(413);
    });
    it(`${name}: accepts a small upload with no Content-Length`, async () => {
      expect((await route(await streamed(name, formWith(csv(NEW_ROW))))).status).toBe(200);
    });
  }
  // Content-Length says 100 but the stream carries 5 MB. The route must count the bytes it really reads,
  // answer 413 with the fixed message, and stop pulling from the stream (it cancels it).
  for (const [name, route] of [
    ["preview", preview],
    ["commit", commit],
  ] as const) {
    it(`${name}: returns 413 and stops reading when Content-Length says 100 but the body is 5 MB`, async () => {
      const chunkBytes = 16 * 1024;
      const totalBytes = 5 * 1024 * 1024;
      const cap = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;
      let pulled = 0;
      let cancelled = false;
      // highWaterMark 0: the stream produces a chunk only when the route asks for one, so `pulled` is what was read.
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulled >= totalBytes) {
              controller.close();
              return;
            }
            pulled += chunkBytes;
            controller.enqueue(new Uint8Array(chunkBytes).fill(0x78));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const request = new Request(`http://localhost/api/import/${name}`, {
        method: "POST",
        body,
        headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "100" },
        duplex: "half",
      } as RequestInit);
      expect(request.headers.get("content-length")).toBe("100");

      const res = await route(request);

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: uploadTooLargeMessage() });
      expect(cancelled).toBe(true);
      expect(pulled).toBeGreaterThan(cap);
      expect(pulled).toBeLessThanOrEqual(cap + chunkBytes);
      expect(pulled).toBeLessThan(totalBytes);
      expect(mocks.close).not.toHaveBeenCalled();
    });
  }
  it("returns 422 from preview and commit for a CSV with 5,001 data rows, and writes nothing", async () => {
    const rows: string[] = [];
    for (let i = 1; i <= MAX_DATA_ROWS + 1; i += 1) rows.push(`INV-${i},Patel Metals,1000,2026-09-02,45`);
    const text = csv(...rows);
    const before = await count("invoices");

    const previewRes = await preview(post("preview", formWith(text)));
    const commitRes = await commit(post("commit", formWith(text)));

    expect(previewRes.status).toBe(422);
    expect(commitRes.status).toBe(422);
    expect(await count("invoices")).toBe(before);
  });
});
