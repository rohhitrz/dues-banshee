"use client";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import styles from "./pending-context.module.css";
export interface GraveyardPending {
  /** True while a time-travel navigation is in flight. */
  pending: boolean;
  /** The href that was clicked while `pending`, otherwise null. */
  target: string | null;
  /** Starts a navigation to `href`. Does nothing while one is already pending. */
  navigate: (href: string) => void;
}
const GraveyardPendingContext = createContext<GraveyardPending | null>(null);
export interface NavigateDeps {
  isPending: boolean;
  push: (href: string) => void;
  startTransition: (callback: () => void) => void;
  setTarget: (href: string) => void;
}
/** Pure core of `navigate`, so the no-double-navigation rule is testable without a DOM. */
export function makeNavigate({ isPending, push, startTransition, setTarget }: NavigateDeps): (href: string) => void {
  return (href) => {
    if (isPending) return;
    setTarget(href);
    startTransition(() => {
      push(href);
    });
  };
}
/**
 * Shares the pending flag of a searchParams-only navigation between the Time_Travel_Control and the
 * data blocks. It never decides Today: the href is navigated to as given and the server resolves it.
 */
export function GraveyardPendingProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [clicked, setClicked] = useState<string | null>(null);
  const push = useCallback((href: string) => router.push(href), [router]);
  const navigate = useMemo(
    () => makeNavigate({ isPending, push, startTransition, setTarget: setClicked }),
    [isPending, push],
  );
  const value = useMemo<GraveyardPending>(
    () => ({ pending: isPending, target: isPending ? clicked : null, navigate }),
    [isPending, clicked, navigate],
  );
  return <GraveyardPendingContext.Provider value={value}>{children}</GraveyardPendingContext.Provider>;
}
export function useGraveyardPending(): GraveyardPending {
  const value = useContext(GraveyardPendingContext);
  if (value === null) throw new Error("useGraveyardPending needs a GraveyardPendingProvider");
  return value;
}
/**
 * Wraps a block of data. While a navigation is pending the block dims and reports aria-busy, but it
 * stays in place and keeps its size, so nothing shifts. It keeps the flex column the page gives its children.
 */
export function PendingDim({ children }: { children: ReactNode }) {
  const { pending } = useGraveyardPending();
  return (
    <div className={styles.dim} aria-busy={pending ? "true" : undefined}>
      {children}
    </div>
  );
}
