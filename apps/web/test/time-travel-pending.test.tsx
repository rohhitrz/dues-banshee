import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ push: vi.fn(), pending: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
// A fixed isPending lets the provider render its pending state without a DOM.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useTransition: () => [mocks.pending, (callback: () => void) => callback()],
}));
import Loading from "@/app/(app)/loading";
import { GraveyardPendingProvider, PendingDim, makeNavigate } from "@/components/graveyard/pending-context";
import {
  PENDING_STATUS_TEXT,
  SUMMONING_TEXT,
  TimeTravel,
  TimeTravelView,
  handlePresetClick,
} from "@/components/graveyard/time-travel";
const LINKS = [
  { href: "/", label: "Today" },
  { href: "/?today=2027-03-10", label: "10 Mar 2027 (tax-bomb week)" },
  { href: "/?today=2027-04-01", label: "1 Apr 2027 (after 31 March)" },
];
function anchors(html: string): { href: string; attrs: string; text: string }[] {
  return [...html.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1] as string)?.[1] ?? "",
    attrs: m[1] as string,
    text: m[2] as string,
  }));
}
function click(overrides: Partial<Parameters<typeof handlePresetClick>[0]> = {}) {
  const preventDefault = vi.fn();
  return {
    event: { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault, ...overrides },
    preventDefault,
  };
}
beforeEach(() => {
  mocks.push.mockReset();
  mocks.pending = false;
});
describe("TimeTravel links", () => {
  it("renders three real links with the same hrefs, labels and aria-current as before", () => {
    const html = renderToStaticMarkup(
      <GraveyardPendingProvider>
        <TimeTravel override="2027-03-10" />
      </GraveyardPendingProvider>,
    );
    expect(anchors(html).map((a) => ({ href: a.href, text: a.text }))).toEqual(
      LINKS.map((l) => ({ href: l.href, text: l.label })),
    );
    expect(anchors(html).map((a) => a.attrs.includes('aria-current="page"'))).toEqual([false, true, false]);
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain("Demo date: 10 Mar 2027");
  });
  it("is idle: an empty polite status region, nothing busy", () => {
    const html = renderToStaticMarkup(
      <GraveyardPendingProvider>
        <TimeTravel override={null} />
        <PendingDim>
          <p>data</p>
        </PendingDim>
      </GraveyardPendingProvider>,
    );
    expect(html).toMatch(/<p [^>]*role="status"[^>]*aria-live="polite"[^>]*><\/p>/);
    expect(html).not.toContain(PENDING_STATUS_TEXT);
    expect(html).not.toContain("aria-busy");
  });
});
describe("TimeTravel while pending", () => {
  const view = (target: string | null) =>
    renderToStaticMarkup(<TimeTravelView override={null} pending target={target} navigate={vi.fn()} />);
  it("shows Summoning… on the clicked preset only", () => {
    const html = view("/?today=2027-04-01");
    expect(anchors(html).map((a) => a.text)).toEqual(["Today", "10 Mar 2027 (tax-bomb week)", SUMMONING_TEXT]);
    expect(SUMMONING_TEXT).toBe("Summoning…");
  });
  it("marks every preset aria-disabled and keeps the real hrefs", () => {
    const anchorList = anchors(view("/"));
    expect(anchorList.map((a) => a.href)).toEqual(LINKS.map((l) => l.href));
    for (const a of anchorList) expect(a.attrs).toContain('aria-disabled="true"');
  });
  it("shows the exact polite status line", () => {
    const html = view("/");
    expect(PENDING_STATUS_TEXT).toBe("The banshee is turning back the clock…");
    expect(html).toMatch(
      /<p [^>]*role="status"[^>]*aria-live="polite"[^>]*>The banshee is turning back the clock…<\/p>/,
    );
  });
  it("dims the data with aria-busy through the provider, keeping the data in the markup", () => {
    mocks.pending = true;
    const html = renderToStaticMarkup(
      <GraveyardPendingProvider>
        <PendingDim>
          <p>Sharma Traders</p>
        </PendingDim>
        <TimeTravel override={null} />
      </GraveyardPendingProvider>,
    );
    expect(html).toMatch(/<div [^>]*aria-busy="true"[^>]*><p>Sharma Traders<\/p><\/div>/);
    expect(html).toContain(PENDING_STATUS_TEXT);
    for (const a of anchors(html)) expect(a.attrs).toContain('aria-disabled="true"');
  });
});
describe("preset click handling", () => {
  it("turns a plain click into one navigation", () => {
    const navigate = vi.fn();
    const { event, preventDefault } = click();
    handlePresetClick(event, "/?today=2027-03-10", { pending: false, navigate });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/?today=2027-03-10");
  });
  it("ignores clicks while pending: no navigation, and the default link action is blocked", () => {
    const navigate = vi.fn();
    const { event, preventDefault } = click();
    handlePresetClick(event, "/?today=2027-04-01", { pending: true, navigate });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("leaves modified and non-primary clicks to the browser", () => {
    for (const overrides of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const navigate = vi.fn();
      const { event, preventDefault } = click(overrides);
      handlePresetClick(event, "/", { pending: false, navigate });
      expect(preventDefault).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    }
  });
});
describe("makeNavigate", () => {
  const start = () => {
    const push = vi.fn();
    const startTransition = vi.fn((callback: () => void) => callback());
    const setTarget = vi.fn();
    return { push, startTransition, setTarget };
  };
  it("pushes the href inside a transition and records the clicked target", () => {
    const deps = start();
    makeNavigate({ isPending: false, ...deps })("/?today=2027-03-10");
    expect(deps.setTarget).toHaveBeenCalledExactlyOnceWith("/?today=2027-03-10");
    expect(deps.startTransition).toHaveBeenCalledOnce();
    expect(deps.push).toHaveBeenCalledExactlyOnceWith("/?today=2027-03-10");
  });
  it("does not push again while a navigation is pending", () => {
    const deps = start();
    const navigate = makeNavigate({ isPending: true, ...deps });
    navigate("/?today=2027-03-10");
    navigate("/");
    expect(deps.push).not.toHaveBeenCalled();
    expect(deps.startTransition).not.toHaveBeenCalled();
    expect(deps.setTarget).not.toHaveBeenCalled();
  });
});
describe("loading.tsx", () => {
  it("renders Raising the dead… as a polite status, with the skeleton hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toMatch(/<p [^>]*role="status"[^>]*aria-live="polite"[^>]*>Raising the dead…<\/p>/);
    expect(html).toContain('aria-hidden="true"');
    expect(html.split("Raising the dead…").length - 1).toBe(1);
    expect(html).not.toMatch(/<a /);
  });
});
