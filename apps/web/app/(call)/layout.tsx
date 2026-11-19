import type { ReactNode } from "react";

// The buyer's call page: no sign-in, no session check. The Join_Token in the URL is the only credential.
export default function CallLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
