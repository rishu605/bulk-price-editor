/**
 * The "something is happening" bar for navigations, and the words for it (#798).
 *
 * Loaders here are not always fast -- a catalogue preview walks thousands of variants
 * -- and React Router keeps the *old* page on screen while the next one's loader runs.
 * Without this, clicking a link looks like clicking a dead link, so people click again
 * and queue a second run of the same work.
 *
 * The 150ms delay is done in CSS rather than with a timer and state. A quick
 * navigation should never flash a progress bar, and expressing that as
 * `animation-delay` keeps the component free of effects that fight React's rules
 * about setting state during a render pass.
 *
 * ## What a screen reader hears
 *
 * The bar used to be the live region: `role="status"`, `aria-label="Loading"`, no text.
 * A live region announces a change to its content and never its label, and this one
 * mounted with the navigation and unmounted at its end, so there was never a region in
 * place for a change to happen in. Nothing was said on leaving a page or on arriving.
 *
 * So the region is separate from the bar and always rendered, and what it says is
 * written into it:
 *
 * - **"Loading"**, once a navigation has run long enough to be worth saying —
 *   `SAY_LOADING_AFTER_MS`, the spoken twin of the bar's CSS delay. A quick navigation
 *   says only where it arrived.
 * - **"Navigated to Campaigns"** on arrival, read off the new page's `s-page` heading.
 *   An action that comes back to the page it was posted from has not arrived anywhere, so
 *   it says nothing; its own banner is the answer.
 *
 * Written by an effect, through a ref, and not rendered as children. The page's name only
 * exists once the new page has rendered — that is after this component's render — and
 * writing to the node rather than to state keeps the effect from setting state, which is
 * what the paragraph above is careful never to do.
 */

import { useEffect, useRef } from "react";
import { useLocation, useNavigation } from "react-router";

import { LiveStatus } from "./LiveStatus";

/** How long a navigation runs before "Loading" is worth interrupting the listener for. */
export const SAY_LOADING_AFTER_MS = 1000;

/** What arriving on a page says, given that page's heading. */
export function arrivalMessage(heading: string | null | undefined): string {
  const name = heading?.trim();
  return name ? `Navigated to ${name}` : "Page loaded";
}

export function RouteProgress() {
  const navigation = useNavigation();
  const location = useLocation();
  const navigating = navigation.state !== "idle";
  const href = location.pathname + location.search;

  const region = useRef<HTMLDivElement>(null);
  // The page this region last spoke for. Starts as the page it loaded on, which the
  // screen reader reads for itself, so the first render announces nothing.
  const spokenFor = useRef(href);

  useEffect(() => {
    const node = region.current;
    if (!node) return;

    if (navigating) {
      // Cleared first, so arriving back on a page with the same name is still a change.
      node.textContent = "";
      const timer = setTimeout(() => {
        node.textContent = "Loading";
      }, SAY_LOADING_AFTER_MS);
      return () => clearTimeout(timer);
    }

    if (spokenFor.current === href) {
      node.textContent = "";
      return;
    }
    spokenFor.current = href;
    node.textContent = arrivalMessage(document.querySelector("s-page")?.getAttribute("heading"));
  }, [navigating, href]);

  return (
    <>
      <LiveStatus ref={region} />
      {navigating ? <ProgressBar /> : null}
    </>
  );
}

function ProgressBar() {
  return (
    <div
      // Decoration: the region above is what says a page is loading.
      aria-hidden="true"
      data-route-progress=""
      style={{
        position: "fixed",
        insetInlineStart: 0,
        insetBlockStart: 0,
        inlineSize: "100%",
        blockSize: "3px",
        overflow: "hidden",
        zIndex: 1000,
        // Invisible until the delay elapses, so a fast navigation shows nothing.
        opacity: 0,
        animation: "anchor-progress-appear 1ms linear 150ms forwards",
      }}
    >
      <div
        style={{
          blockSize: "100%",
          inlineSize: "35%",
          background: "currentColor",
          opacity: 0.7,
          borderRadius: "999px",
          animation: "anchor-progress 1.1s ease-in-out infinite",
        }}
      />
      {/* Scoped keyframes: this renders inside Shopify's frame, where a stylesheet of
          our own is not guaranteed to have loaded. */}
      <style>{`
        @keyframes anchor-progress-appear { to { opacity: 1; } }
        @keyframes anchor-progress {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(340%); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-route-progress] > div { animation: none; opacity: 0.45; }
        }
      `}</style>
    </div>
  );
}
