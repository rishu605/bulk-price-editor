/**
 * A navigation is heard, not only seen (#798).
 *
 * The progress bar carried `role="status"` and `aria-label="Loading"` and no text. A live
 * region announces a change to its content, never its label, so nothing was said; and the
 * whole element mounted with a navigation and unmounted at its end, so there was never a
 * region in place for a change to happen in. Arriving on the new page said nothing either.
 *
 * Rendered with the router's navigation state stubbed, in a file of its own so that stub
 * reaches nothing else. The words themselves are written by an effect — after the new
 * page has rendered, because that is when its heading exists to be read — and an effect
 * does not run in a static render; `arrivalMessage` is the part of it that decides what
 * is said, and is asserted directly.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ state: "idle" as "idle" | "loading" | "submitting" }));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigation: () => navigation,
  useLocation: () => ({ pathname: "/app/campaigns", search: "", hash: "", state: null, key: "k1" }),
}));

import { arrivalMessage, RouteProgress } from "./RouteProgress";

/** The live regions in some markup, as their opening tags. */
const regions = (html: string) => html.match(/<div[^>]*\brole="status"[^>]*>/g) ?? [];

beforeEach(() => {
  navigation.state = "idle";
});

describe("the navigation's live region", () => {
  it("is on the page when nothing is loading, so it exists before the next navigation", () => {
    const html = renderToStaticMarkup(<RouteProgress />);

    expect(regions(html), "no region while idle means nothing to announce into").toHaveLength(1);
  });

  it("is the same region while a page loads, not a second one mounted for it", () => {
    const idle = regions(renderToStaticMarkup(<RouteProgress />));
    navigation.state = "loading";
    const loading = regions(renderToStaticMarkup(<RouteProgress />));

    expect(loading).toEqual(idle);
  });

  it("is spoken, not labelled", () => {
    navigation.state = "loading";
    const [tag] = regions(renderToStaticMarkup(<RouteProgress />));

    expect(tag).toContain('aria-live="polite"');
    expect(tag, "a live region's label is never announced").not.toContain("aria-label");
  });

  it("still draws the bar while a page loads, and only then", () => {
    navigation.state = "loading";
    expect(renderToStaticMarkup(<RouteProgress />)).toContain("anchor-progress");

    navigation.state = "idle";
    expect(renderToStaticMarkup(<RouteProgress />)).not.toContain("anchor-progress");
  });

  it("keeps the bar's reduced-motion rule pointed at the bar", () => {
    // The rule selected `[role="status"] > div`. The region is not the bar any more, so a
    // selector on the role would now style nothing and the bar would animate regardless.
    navigation.state = "loading";
    const html = renderToStaticMarkup(<RouteProgress />);

    expect(html).not.toContain('[role="status"]');
    expect(html).toMatch(/data-route-progress/);
  });
});

describe("what arriving says", () => {
  it("names the page it arrived on", () => {
    expect(arrivalMessage("Campaigns")).toBe("Navigated to Campaigns");
  });

  it("still says something on a page with no heading", () => {
    expect(arrivalMessage(null)).toBe("Page loaded");
    expect(arrivalMessage("  ")).toBe("Page loaded");
  });
});
