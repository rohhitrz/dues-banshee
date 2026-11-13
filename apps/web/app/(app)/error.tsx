"use client";

import { LoadError } from "@/components/graveyard/load-error";
import styles from "./error.module.css";

/**
 * Backstop for render errors under `(app)`. The error prop is deliberately never read: the
 * markup is fixed text from LoadError plus a retry link to `/`, so no message, stack, name or
 * digest can reach the page (Req 11.1, 11.2).
 */
export default function AppError() {
  return (
    <main className={styles.page}>
      <LoadError />
    </main>
  );
}
