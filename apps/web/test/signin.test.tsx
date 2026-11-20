import { AuthError, CredentialsSignin } from "next-auth";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  redirect: vi.fn((url: string) => {
    // Next's redirect() never returns: it throws to navigate.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock("@/auth", () => ({ signIn: mocks.signIn }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { signInDemo } from "@/app/(site)/signin/actions";
import SignInPage from "@/app/(site)/signin/page";

const NOT_SEEDED = "Demo data is not seeded";
const GENERIC = "Sign-in failed. Please try again.";

afterEach(() => {
  mocks.signIn.mockReset();
  mocks.redirect.mockClear();
});

describe("signInDemo", () => {
  it("signs in as the demo supplier and lands on /", async () => {
    mocks.signIn.mockResolvedValue(undefined);

    await signInDemo();

    expect(mocks.signIn).toHaveBeenCalledWith("demo", { redirectTo: "/" });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects with error=demo when authorizeDemo returned null (CredentialsSignin)", async () => {
    mocks.signIn.mockRejectedValue(new CredentialsSignin());

    await expect(signInDemo()).rejects.toThrow("NEXT_REDIRECT /signin?error=demo");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin?error=demo");
  });

  it("redirects with error=failed for any other AuthError, such as authorize throwing", async () => {
    // Auth.js wraps an exception thrown inside authorize() (for example, the database being down).
    const wrapped = new AuthError("authorize threw", { cause: new Error("connection refused") });
    mocks.signIn.mockRejectedValue(wrapped);

    await expect(signInDemo()).rejects.toThrow("NEXT_REDIRECT /signin?error=failed");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin?error=failed");
  });

  it("rethrows an error that is not an AuthError, such as Next's own redirect", async () => {
    const navigation = new Error("NEXT_REDIRECT /import");
    mocks.signIn.mockRejectedValue(navigation);

    await expect(signInDemo()).rejects.toBe(navigation);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

async function renderPage(error?: string | string[]): Promise<string> {
  const element = await SignInPage({ searchParams: Promise.resolve(error === undefined ? {} : { error }) });
  return renderToStaticMarkup(element);
}

function alertText(html: string): string | null {
  const match = /<p role="alert"[^>]*>([^<]*)<\/p>/.exec(html);
  return match === null ? null : (match[1] ?? null);
}

describe("sign-in page landing link", () => {
  it('links "What is Dues Banshee?" to /landing', async () => {
    expect(await renderPage()).toMatch(/<a [^>]*href="\/landing"[^>]*>What is Dues Banshee\?<\/a>/);
  });
});

describe("sign-in page error message", () => {
  it("shows no message without an error", async () => {
    expect(alertText(await renderPage())).toBeNull();
  });

  it('shows "Demo data is not seeded" for error=demo', async () => {
    expect(alertText(await renderPage("demo"))).toBe(NOT_SEEDED);
  });

  it("shows the generic message for error=failed", async () => {
    expect(alertText(await renderPage("failed"))).toBe(GENERIC);
  });

  it.each(["CredentialsSignin", "Configuration", "Demo", "demo ", "x"])(
    "shows the generic message, not the not-seeded one, for unknown error=%s",
    async (value) => {
      expect(alertText(await renderPage(value))).toBe(GENERIC);
    },
  );

  it("uses the first value when error is repeated", async () => {
    expect(alertText(await renderPage(["demo", "failed"]))).toBe(NOT_SEEDED);
    expect(alertText(await renderPage(["bogus", "demo"]))).toBe(GENERIC);
  });
});
