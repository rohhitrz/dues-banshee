"use client";
import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
export interface InFlight {
  current: boolean;
}
/**
 * Called from `onSubmit`, before React runs the form's action. The first submit marks the form in flight
 * and goes through. A second submit while one is in flight is cancelled with `preventDefault()`, which
 * makes React skip the action. The disabled buttons alone miss a double click or Enter pressed before
 * the pending state has rendered.
 */
export function guardSubmit(inFlight: InFlight, event: { preventDefault(): void }): void {
  if (inFlight.current) {
    event.preventDefault();
    return;
  }
  inFlight.current = true;
}
/** Clears the in-flight mark when the form's action has settled (`pending` is false again). */
export function ResetWhenSettled({ inFlight }: { inFlight: InFlight }): null {
  const { pending } = useFormStatus();
  useEffect(() => {
    if (!pending) inFlight.current = false;
  }, [pending, inFlight]);
  return null;
}
export interface GuardedFormProps extends Omit<ComponentProps<"form">, "action" | "onSubmit"> {
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
}
/**
 * A form that ignores a second submit while one is in flight. `action` is passed straight through, so a
 * server action keeps working as a server reference. No lock is taken in the database.
 */
export function GuardedForm({ action, children, ...rest }: GuardedFormProps) {
  const inFlight = useRef(false);
  return (
    <form {...rest} action={action} onSubmit={(event) => guardSubmit(inFlight, event)}>
      <ResetWhenSettled inFlight={inFlight} />
      {children}
    </form>
  );
}
