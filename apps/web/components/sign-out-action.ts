"use server";
import { signOut } from "@/auth";

/** Ends the Auth.js session and sends the user to the sign-in page. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}
