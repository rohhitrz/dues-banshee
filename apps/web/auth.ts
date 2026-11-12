import { DEMO_SUPPLIER, findSupplierIdByUdyam } from "@dues-banshee/db";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config";
import { getDb } from "@/lib/db";

/**
 * Demo sign-in: no credentials, it signs in as the seeded demo supplier.
 * Returns null when the demo supplier isn't in the database.
 */
export async function authorizeDemo(): Promise<{ id: string; name: string; supplierId: string } | null> {
  const { db, close } = getDb();
  try {
    const supplierId = await findSupplierIdByUdyam(db, DEMO_SUPPLIER.udyamNumber);
    if (supplierId === null) return null;
    return { id: "demo-user", name: "Demo owner", supplierId };
  } finally {
    await close();
  }
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [Credentials({ id: "demo", credentials: {}, authorize: authorizeDemo })],
});
