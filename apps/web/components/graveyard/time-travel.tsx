"use client";
import Link from "next/link";
import type { MouseEvent } from "react";
import type { CalendarDate } from "@dues-banshee/engine";
import { TIME_TRAVEL_PRESETS, formatDisplayDate } from "@/lib/graveyard/today";
import { useGraveyardPending } from "./pending-context";
import styles from "./time-travel.module.css";
export const SUMMONING_TEXT = "Summoning…";
export const PENDING_STATUS_TEXT = "The banshee is turning back the clock…";
export interface TimeTravelProps {
  /** The accepted `?today=` value, or null when Today is the real IST date. */
  override: CalendarDate | null;
}
export interface TimeTravelViewProps extends TimeTravelProps {
  pending: boolean;
  /** The href of the clicked preset while pending, otherwise null. */
  target: string | null;
  navigate: (href: string) => void;
}
interface ClickEventLike {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault: () => void;
}
/**
 * Click handling for a preset link. A plain left click is turned into a transition. While one is
 * pending, every click is swallowed. Modified clicks (new tab, new window) keep the browser's default,
 * and the link still works as a normal link without JavaScript.
 */
export function handlePresetClick(
  event: ClickEventLike,
  href: string,
  { pending, navigate }: { pending: boolean; navigate: (href: string) => void },
): void {
  if (pending) {
    event.preventDefault();
    return;
  }
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(href);
}
export function TimeTravelView({ override, pending, target, navigate }: TimeTravelViewProps) {
  return (
    <nav className={styles.wrap} aria-label="Time travel">
      <ul className={styles.list}>
        {TIME_TRAVEL_PRESETS.map((preset) => {
          const href = preset.today === null ? "/" : `/?today=${preset.today}`;
          return (
            <li key={preset.label}>
              <Link
                className={styles.link}
                href={href}
                aria-current={preset.today === override ? "page" : undefined}
                aria-disabled={pending ? "true" : undefined}
                onClick={(event: MouseEvent<HTMLAnchorElement>) =>
                  handlePresetClick(event, href, { pending, navigate })
                }
              >
                {pending && target === href ? SUMMONING_TEXT : preset.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {override === null ? null : (
        <p className={styles.chip}>{`Demo date: ${formatDisplayDate(override)}`}</p>
      )}
      <p className={styles.status} role="status" aria-live="polite">
        {pending ? PENDING_STATUS_TEXT : null}
      </p>
    </nav>
  );
}
/** Three real links that navigate in a transition. Today is still resolved on the server from the URL. */
export function TimeTravel({ override }: TimeTravelProps) {
  const { pending, target, navigate } = useGraveyardPending();
  return <TimeTravelView override={override} pending={pending} target={target} navigate={navigate} />;
}
