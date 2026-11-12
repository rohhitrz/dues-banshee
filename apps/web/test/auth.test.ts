import { DEMO_SUPPLIER, seed } from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the mock's state has to be hoisted with it.
const mocks = vi.hoisted(() => ({
  current: undefined as unknown,
  close: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/db", () => {
  mocks.close = vi.fn(async () => {});
  return {
    getDb: () => ({ db: (mocks.current as TestDb).db, close: mocks.close }),
  };
});

// Importing `auth.ts` runs `NextAuth(...)`, which pulls in `next/server`. Only `authorizeDemo` is under
// test here, so replace the two Auth.js entry points with minimal stand-ins.
vi.mock("next-auth", () => ({
  default: () => ({ auth: vi.fn(), handlers: {}, signIn: vi.fn(), signOut: vi.fn() }),
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));

import { authConfig } from "@/auth.config";
import { authorizeDemo } from "@/auth";

let template: TestDb;
let seeded: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
  seeded = await cloneTestDb(template);
  await seed(seeded.db);
});

afterAll(async () => {
  await seeded.close();
  await template.close();
});

afterEach(async () => {
  mocks.close.mockClear();
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function cloneOf(source: TestDb): Promise<TestDb> {
  const t = await cloneTestDb(source);
  open.push(t);
  mocks.current = t;
  return t;
}

describe("authorizeDemo", () => {
  it("returns the seeded demo supplier's id as supplierId", async () => {
    const t = await cloneOf(seeded);
    // Looked up with raw SQL, independently of `findSupplierIdByUdyam`.
    const { rows } = await t.pglite.query<{ id: string }>("select id from suppliers where udyam_number = $1", [
      DEMO_SUPPLIER.udyamNumber,
    ]);
    expect(rows).toHaveLength(1);

    const user = await authorizeDemo();

    expect(user).toEqual({ id: "demo-user", name: "Demo owner", supplierId: rows[0]?.id });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns null on a database without the demo supplier", async () => {
    await cloneOf(template);

    expect(await authorizeDemo()).toBeNull();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("authConfig callbacks", () => {
  const supplierId = "5f0c3a4e-0000-4000-8000-000000000001";

  it("jwt copies supplierId from the user onto the token", async () => {
    const token = await authConfig.callbacks.jwt({
      token: { sub: "demo-user" },
      user: { id: "demo-user", supplierId },
    } as never);

    expect(token).toMatchObject({ sub: "demo-user", supplierId });
  });

  it("jwt leaves the token's supplierId alone on later requests (no user)", async () => {
    const token = await authConfig.callbacks.jwt({ token: { supplierId } } as never);

    expect(token).toEqual({ supplierId });
  });

  it("session copies supplierId from the token onto the session", async () => {
    const session = await authConfig.callbacks.session({
      session: { user: { name: "Demo owner" }, expires: "2099-01-01T00:00:00.000Z" },
      token: { supplierId },
    } as never);

    expect(session.supplierId).toBe(supplierId);
  });

  it("session ignores a non-string supplierId on the token", async () => {
    const session = await authConfig.callbacks.session({
      session: { user: { name: "Demo owner" }, expires: "2099-01-01T00:00:00.000Z" },
      token: { supplierId: 42 },
    } as never);

    expect(session.supplierId).toBeUndefined();
  });
});
