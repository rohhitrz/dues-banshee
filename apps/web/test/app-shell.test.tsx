import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signOut: mocks.signOut }));

import { DISCLAIMER } from "@dues-banshee/agent";
import { AppShell, FOOTER_TEXT } from "@/components/app-shell";
import { signOutAction } from "@/components/sign-out-action";

const FOOTER = "Reminders a supplier sends to its own buyers. Not legal advice.";

afterEach(() => {
  mocks.auth.mockReset();
  mocks.signOut.mockReset();
});

async function render(session: unknown): Promise<string> {
  mocks.auth.mockResolvedValue(session);
  const element = await AppShell({ children: <main>page body</main> });
  return renderToStaticMarkup(element);
}

/** The text of every `<a href="...">` in the markup, keyed by href. */
function links(html: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)) {
    found[match[1] as string] = match[2] as string;
  }
  return found;
}

describe("AppShell with a supplierId", () => {
  it('links "Graveyard" to /, "Approvals" to /approvals and "Import" to /import', async () => {
    const html = await render({ supplierId: "supplier-1" });

    expect(links(html)).toEqual({ "/": "Graveyard", "/approvals": "Approvals", "/import": "Import" });
  });

  it("lists the nav links in the order Graveyard, Approvals, Import", async () => {
    const html = await render({ supplierId: "supplier-1" });

    expect(Object.keys(links(html))).toEqual(["/", "/approvals", "/import"]);
  });

  it("uses the agent's DISCLAIMER as the footer text", () => {
    expect(FOOTER_TEXT).toBe(DISCLAIMER);
    expect(FOOTER_TEXT).toBe(FOOTER);
  });

  it('has a "Sign out" submit button inside a form', async () => {
    const html = await render({ supplierId: "supplier-1" });

    expect(html).toMatch(/<form [^>]*>\s*<button [^>]*type="submit"[^>]*>Sign out<\/button>\s*<\/form>/);
  });

  it("renders the footer text and the children", async () => {
    const html = await render({ supplierId: "supplier-1" });

    expect(html).toContain(FOOTER);
    expect(html).toContain("<main>page body</main>");
  });
});

describe.each([
  ["no session", null],
  ["a session without supplierId", { user: { name: "someone" } }],
  ["a session with an empty supplierId", { supplierId: "" }],
])("AppShell with %s", (_label, session) => {
  it("has no nav links and no Sign out control", async () => {
    const html = await render(session);

    expect(links(html)).toEqual({});
    expect(html).not.toContain("Graveyard</a>");
    expect(html).not.toContain("Approvals</a>");
    expect(html).not.toContain('href="/approvals"');
    expect(html).not.toContain("Import</a>");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });

  it("still renders the footer text and the children", async () => {
    const html = await render(session);

    expect(html).toContain(FOOTER);
    expect(html).toContain("<main>page body</main>");
  });
});

describe("signOutAction", () => {
  it('calls signOut({ redirectTo: "/signin" })', async () => {
    mocks.signOut.mockResolvedValue(undefined);

    await signOutAction();

    expect(mocks.signOut).toHaveBeenCalledExactlyOnceWith({ redirectTo: "/signin" });
  });

  it("rethrows what signOut throws, such as Next's own redirect", async () => {
    const navigation = new Error("NEXT_REDIRECT /signin");
    mocks.signOut.mockRejectedValue(navigation);

    await expect(signOutAction()).rejects.toBe(navigation);
  });
});
