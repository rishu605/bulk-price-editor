/**
 * The "something is happening" bar for navigations.
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
 */

import { useNavigation } from "react-router";

export function RouteProgress() {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading"
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
          [role="status"] > div { animation: none; opacity: 0.45; }
        }
      `}</style>
    </div>
  );
}
