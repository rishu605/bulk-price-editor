import { useEffect } from "react";

import { SPACE } from "../lib/ui/spacing";

export interface JumpTarget {
  /** Must match the `id` on the `s-section` it points at. */
  id: string;
  label: string;
}

/**
 * A page's own contents, for pages long enough to get lost in.
 *
 * ## Why it did nothing
 *
 * It was three `s-button href="#guardrails"` — real anchors pointing at real ids, which
 * is why it looked correct. A bare fragment href hands the job to the browser's fragment
 * navigation, and that scrolls **the document's scrolling element**. This app is laid out
 * inside App Home's frame by Shopify's runtime, and it does not know or control whether
 * the thing that scrolls is the document or a container Polaris renders. If it is a
 * container, fragment navigation moves nothing and reports nothing.
 *
 * `scrollIntoView` does not take that bet — it walks up and scrolls every scrollable
 * ancestor — so this is correct whichever the answer turns out to be. The `href` stays,
 * because it is what makes these real links: middle-click, open-in-new-tab and copy-link
 * all keep working, and the handler is an enhancement over a thing that already means
 * something rather than a click listener glued to a span.
 *
 * ## Arriving with a hash
 *
 * Also handled, and it was not before: nothing in the app read `location.hash`, so
 * `/app/settings#notifications` from a runbook or an email landed at the top of the page
 * and stayed there. That is half of what in-page anchors are for.
 *
 * Instant on arrival, smooth on click. Smoothly animating a page the merchant has only
 * just opened reads as the page moving on its own; smoothly animating one they pressed a
 * control on reads as the control working. Both defer to `prefers-reduced-motion`.
 *
 * ## Why chips and not text
 *
 * Because three text labels in a row are a tab bar, whatever the spacing. This sat in a
 * card of its own directly under the section tab bar, so the page opened with two rows of
 * similar-weight labels in two boxes — and the lower one was the almost-empty rectangle
 * #395 took off the campaigns index.
 *
 * `s-clickable-chip` is a different object: compact, rounded, and not something the app
 * uses for navigation anywhere else, so it cannot be confused with one. The arrow says
 * which way it goes, which is the one thing a tab never does. No card, no rule, no "Jump
 * to" label — the arrows are the label, and the landmark carries the words for anyone who
 * cannot see them.
 */
export function JumpTo({
  targets,
  label = "On this page",
}: {
  targets: JumpTarget[];
  /** Names the landmark, so a screen reader hears what it has jumped to. */
  label?: string;
}) {
  // A hash the merchant arrived with, once the sections are on the page. Not on every
  // render: this must not fight a merchant who has scrolled somewhere else since.
  useEffect(() => {
    const id = globalThis.location?.hash?.slice(1);
    if (id) scrollToSection(id, "auto");
  }, []);

  if (targets.length === 0) return null;

  return (
    <s-box accessibilityRole="navigation" accessibilityLabel={label}>
      <s-stack direction="inline" gap={SPACE.item} alignItems="center">
        {targets.map((target) => (
          <s-clickable-chip
            key={target.id}
            href={`#${target.id}`}
            onClick={(event) => {
              // Only when we can do better than the browser would. If the section is not
              // on the page — a conditional block that did not render — the anchor is
              // left to do whatever it was going to do, rather than being cancelled into
              // a control that visibly does nothing.
              if (scrollToSection(target.id, "smooth")) event.preventDefault();
            }}
          >
            <s-icon slot="graphic" type="arrow-down" size="small" />
            {target.label}
          </s-clickable-chip>
        ))}
      </s-stack>
    </s-box>
  );
}

/**
 * Scroll a section into view, if it is there.
 *
 * Returns whether it found one, so the caller can decide whether to cancel the anchor.
 *
 * `block: "start"` rather than `"center"`: these are section headings, and a heading
 * parked in the middle of the screen with its own content below the fold is a worse
 * landing than one at the top with the section under it.
 */
function scrollToSection(id: string, behavior: "smooth" | "auto"): boolean {
  const target = globalThis.document?.getElementById(id);
  if (!target) return false;

  target.scrollIntoView({ behavior: prefersMotion() ? behavior : "auto", block: "start" });
  return true;
}

/**
 * Whether the merchant is willing to be moved.
 *
 * `matchMedia` is optional-chained for the server render and for the test environment,
 * where it does not exist; the default when it cannot be asked is to animate, because
 * that is what a browser that never heard of the query does.
 */
function prefersMotion(): boolean {
  return !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}
