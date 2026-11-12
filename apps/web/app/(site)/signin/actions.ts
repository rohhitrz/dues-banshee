"use server";
import { signIn } from "@/auth";
import { AuthError, CredentialsSignin } from "next-auth";
import { redirect } from "next/navigation";
import { DEMO_NOT_SEEDED_ERROR, SIGN_IN_FAILED_ERROR } from "./messages";
/**
 * Signs in as the seeded demo supplier. On failure it returns to the sign-in page with an error flag:
 * "demo" when `authorizeDemo` returned null (Auth.js throws CredentialsSignin), "failed" for any other
 * Auth.js error, such as the database being unreachable.
 */
export async function signInDemo(): Promise<void> {
  try {
    await signIn("demo", { redirectTo: "/import" });
  } catch (error) {
    // Next's redirect() throws NEXT_REDIRECT to navigate. Only auth failures are handled here.
    if (error instanceof CredentialsSignin) redirect(`/signin?error=${DEMO_NOT_SEEDED_ERROR}`);
    if (error instanceof AuthError) redirect(`/signin?error=${SIGN_IN_FAILED_ERROR}`);
    throw error;
  }
}
