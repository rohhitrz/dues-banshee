"use client";
import { useSearchParams } from "next/navigation";
import { LoadError } from "@/components/graveyard/load-error";
import styles from "./error.module.css";
/**
 * Backstop for render errors under `(app)`. The error prop is deliberately never read: the
 * markup is fixed text from LoadError plus a retry link to `/`, so no message, stack, name or
 * digest can reach the page (Req 11.1, 11.2). The only input is the `today` query value, which
 * keeps a demo date on the retry link; LoadError URL-encodes it.
 */
export default function AppError() {
  const todayRaw = useSearchParams().get("today") ?? undefined;
  return (
    <main className={styles.page}>
      <LoadError todayRaw={todayRaw} />
    </main>
  );
}
