"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

export interface SubmitButtonProps {
  className?: string | undefined;
  /** Sent with the form, so one form can hold several buttons (for example the redraft languages). */
  name?: string | undefined;
  value?: string | undefined;
  pendingLabel: string;
  children: ReactNode;
}

/** A real submit button that disables itself while its form's server action runs (a redraft calls an LLM). */
export function SubmitButton({ className, name, value, pendingLabel, children }: SubmitButtonProps) {
  const { pending, data } = useFormStatus();
  const mine = pending && (name === undefined || data?.get(name) === value);
  return (
    <button type="submit" className={className} name={name} value={value} disabled={pending} aria-busy={mine}>
      {mine ? pendingLabel : children}
    </button>
  );
}
