import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router";

/**
 * A client-side link the browser has not painted.
 *
 * The app renders its own controls out of `s-box` — a tab, a filter chip — and then has
 * to make them navigable. `s-button href` is an anchor but reloads the document, which is
 * wrong for a control pressed several times a minute, so these wrap a react-router
 * `Link`. A `Link` renders a bare `<a>`, and a bare `<a>` is styled by the *browser*:
 * blue, underlined, and immune to anything the Polaris element inside it says.
 *
 * That is not a hypothetical. The campaigns index shipped with "List" as a grey pill and
 * "Calendar" as browser-blue underlined text sitting next to it — one control rendered
 * two ways, which reads as a sentence with a link in it rather than as a choice.
 *
 * Wrapping the label in `s-text` was the previous attempt and cannot work: `color` might
 * be inherited, but `text-decoration` is drawn by the *ancestor* that set it, and no
 * descendant can remove it. It has to come off the anchor itself.
 *
 * Three declarations, no more. Everything else about how the control looks belongs to the
 * `s-box` inside — this component's whole job is to stop the browser having an opinion.
 */
const UNPAINTED: CSSProperties = {
  color: "inherit",
  textDecoration: "none",
  // So the anchor is exactly the box it wraps, and the whole control is the click target
  // rather than just the run of text inside it.
  display: "block",
};

export function PlainLink({
  to,
  preventScrollReset,
  children,
}: {
  to: string;
  /** See `TabBar` — set when the link swaps a panel rather than changing page. */
  preventScrollReset?: boolean;
  children: ReactNode;
}) {
  return (
    <Link to={to} preventScrollReset={preventScrollReset} style={UNPAINTED}>
      {children}
    </Link>
  );
}
