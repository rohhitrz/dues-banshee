import { auth } from "@/auth";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

// No `loading.tsx` in this group, on purpose: a Suspense boundary above the page would stream the
// shell first, and a later `notFound()` or `redirect()` would then come back as HTTP 200.
export default async function DebtorLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.supplierId) redirect("/signin");
  return <>{children}</>;
}
