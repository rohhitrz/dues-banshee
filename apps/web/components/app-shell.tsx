import { auth } from "@/auth";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./app-shell.module.css";
import { signOutAction } from "./sign-out-action";

export const FOOTER_TEXT = "Reminders a supplier sends to its own buyers. Not legal advice.";

/** Themed page frame. The nav and the sign-out control appear only while the session has a `supplierId`. */
export async function AppShell({ children }: { children: ReactNode }) {
  const session = await auth();
  const signedIn = Boolean(session?.supplierId);
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>Dues Banshee</span>
        {signedIn ? (
          <nav aria-label="Main" className={styles.nav}>
            <Link href="/" className={styles.link}>
              Graveyard
            </Link>
            <Link href="/import" className={styles.link}>
              Import
            </Link>
            <form action={signOutAction} className={styles.signOut}>
              <button type="submit" className={styles.button}>
                Sign out
              </button>
            </form>
          </nav>
        ) : null}
      </header>
      <div className={styles.content}>{children}</div>
      <footer className={styles.footer}>
        <p className={styles.footerText}>{FOOTER_TEXT}</p>
      </footer>
    </div>
  );
}
