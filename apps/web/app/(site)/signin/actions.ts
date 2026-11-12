"use server";

import { signIn } from "@/auth";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

/** Signs in as the seeded demo supplier. A missing demo supplier sends the user back with an error flag. */
export async function signInDemo(): Promise<void> {
  try {
    await signIn("demo", { redirectTo: "/import" });
  } catch (error) {
    // Next's redirect() throws NEXT_REDIRECT to navigate. Only auth failures are handled here.
    if (error instanceof AuthError) redirect("/signin?error=demo");
    throw error;
  }
}
