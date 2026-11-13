import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.query) }));
import AppError from "@/app/(app)/error";
import NotFound from "@/app/not-found";

const MESSAGE = "connection refused: select * from invoices where supplier_id = 'abc'";
const STACK = "Error: connection refused\n    at query (/srv/db.ts:12:3)\n    at load (/srv/load.ts:40:9)";
const DIGEST = "digest-1234567890";

describe("Not_Found_Page", () => {
  it("renders fixed text with a link to /", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain("This grave is empty");
    expect(html).toMatch(/<a class="[^"]*" href="\/">Back to the graveyard<\/a>/);
  });
});

describe("(app) error boundary", () => {
  beforeEach(() => {
    mocks.query = "";
  });
  it("renders none of the error message, stack, digest or SQL and links retry to /", () => {
    const error = Object.assign(new Error(MESSAGE), { digest: DIGEST, stack: STACK });
    // Next passes { error, reset }; the component takes no props and must not render them.
    const Boundary = AppError as unknown as (p: { error: Error; reset: () => void }) => React.ReactElement;
    const html = renderToStaticMarkup(<Boundary error={error} reset={() => undefined} />);

    expect(html).toContain("We couldn&#x27;t load your graveyard just now. Please try again.");
    expect(html).toMatch(/<a class="[^"]*" href="\/">Try again<\/a>/);
    for (const leaked of [
      MESSAGE,
      "connection refused",
      "select * from invoices",
      "supplier_id",
      STACK,
      "/srv/db.ts",
      DIGEST,
    ]) {
      expect(html).not.toContain(leaked);
    }
  });
  it("keeps the demo date on the retry link and still renders no error data", () => {
    mocks.query = "today=2027-03-10";
    const error = Object.assign(new Error(MESSAGE), { digest: DIGEST, stack: STACK });
    const Boundary = AppError as unknown as (p: { error: Error; reset: () => void }) => React.ReactElement;
    const html = renderToStaticMarkup(<Boundary error={error} reset={() => undefined} />);
    expect(html).toMatch(/<a class="[^"]*" href="\/\?today=2027-03-10">Try again<\/a>/);
    expect(html.replace(/<[^>]*>/g, "")).toBe(
      "We couldn&#x27;t load your graveyard just now. Please try again.Try again",
    );
    for (const leaked of [MESSAGE, STACK, DIGEST, "connection refused", "select * from invoices"]) {
      expect(html).not.toContain(leaked);
    }
  });
  it("URL-encodes the raw today value in the retry link", () => {
    mocks.query = "today=2027-03-10%26x%3D1";
    const html = renderToStaticMarkup(<AppError />);
    expect(html).toContain('href="/?today=2027-03-10%26x%3D1"');
  });
});
