import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  // A stale session: the cookie is still valid but its supplier row was deleted by a demo reset.
  auth: vi.fn(async () => ({ user: { supplierId: "stale-supplier-id" } })),
  redirect: vi.fn((url: string) => {
    // Next's redirect() never returns: it throws to navigate.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock("@/auth", () => ({ signIn: mocks.signIn, auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import SignInPage from "@/app/(site)/signin/page";

const SESSION_EXPIRED = "The demo was reset. Enter the graveyard again.";

afterEach(() => {
  mocks.redirect.mockClear();
  mocks.auth.mockClear();
});

describe("/signin?error=SessionExpired", () => {
  it("renders the demo-reset message in the alert", async () => {
    const element = await SignInPage({ searchParams: Promise.resolve({ error: "SessionExpired" }) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain(`<p role="alert"`);
    expect(html).toContain(SESSION_EXPIRED);
    expect(html).toContain("Enter the graveyard (demo)");
  });

  it("does not redirect, even though a session with a supplierId exists (no redirect loop)", async () => {
    const session = await mocks.auth();
    expect(session.user.supplierId).toBeTruthy();

    const element = await SignInPage({ searchParams: Promise.resolve({ error: "SessionExpired" }) });
    renderToStaticMarkup(element);

    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
