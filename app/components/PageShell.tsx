import { Children, cloneElement, isValidElement, type ReactNode } from "react";

import { SPACE } from "../lib/ui/spacing";

/**
 * Every page in the app, at the full width of the screen.
 *
 * `s-page` defaults to `inlineSize="base"`, a ~660px column. On a 1300px viewport that
 * left roughly half the screen empty while the tables inside it wrapped — which is a
 * strange thing for an app whose whole job is showing a merchant thousands of rows.
 *
 * The catch that makes this more than one attribute: Polaris renders the `aside` slot
 * **only** when `inlineSize` is `"base"`. Nineteen sections across thirteen routes use
 * it, and four of them are on the campaign page — including the one holding apply,
 * revert, resume and cancel. Setting `inlineSize="large"` and nothing else would have
 * deleted the apply button with no error and no empty box, which is the kind of
 * failure nobody finds until a merchant reports it.
 *
 * So the aside is rebuilt here rather than abandoned. Children marked `slot="aside"`
 * are partitioned out and rendered in a second column, and the routes keep writing
 * exactly what they wrote before. The alternative — hand-editing nineteen JSX blocks
 * out of their pages and into a prop — is the same change with far more opportunity to
 * drop one.
 *
 * The column collapses under 900px so the aside falls below the content rather than
 * being squeezed into something unreadable. It is a container query, not a media
 * query: the app renders in an admin iframe whose width is not the window's.
 *
 * ## The page rhythm lives here
 *
 * Both branches wrap their content in a stack at `SPACE.page`, and that is the only
 * place in the app the distance between top-level sections is decided. Two reasons it
 * is not left to the routes:
 *
 * - The two branches used to disagree. A page with an aside got `gap="base"` between its
 *   sections; a page without one fell through to whatever `s-page` does with loose
 *   children. Same app, two rhythms, decided by whether the page happened to have a
 *   sidebar — which is exactly the kind of accident that reads as "unstyled".
 * - Page rhythm has to be the largest gap on the screen to do its job. If a route can set
 *   it, some route eventually sets it smaller than the gaps inside its own sections, and
 *   the page stops having visible structure at all.
 */
export function PageShell({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  const all = Children.toArray(children);
  const isAside = (child: ReactNode) =>
    isValidElement(child) && (child.props as { slot?: string }).slot === "aside";

  const aside = all.filter(isAside);
  const main = all.filter((child) => !isAside(child));

  if (aside.length === 0) {
    return (
      <s-page heading={heading} inlineSize="large">
        <s-stack gap={SPACE.page}>{main}</s-stack>
      </s-page>
    );
  }

  return (
    <s-page heading={heading} inlineSize="large">
      <s-grid
        gap={SPACE.page}
        // The column gap is the page rhythm too, not a smaller one. Two columns set
        // closer together than the sections stacked within them read as one column of
        // torn paper, because the strongest gap on the screen would then be running the
        // wrong way.
        //
        // One comma only. Polaris splits a responsive value on the comma to separate
        // "when the query matches" from "otherwise", so a `minmax(0, 1fr)` in here
        // takes its own comma as that separator and the whole value stops parsing --
        // which silently falls back to `none` and stacks the aside underneath, looking
        // exactly like a layout choice rather than a broken string.
        gridTemplateColumns="@container (inline-size <= 900px) 1fr, 1fr 22rem"
        // Without this the aside column stretches to the height of the main content, so
        // a one-line sidebar next to a long table becomes a very tall empty card.
        alignItems="start"
      >
        <s-stack gap={SPACE.page}>{main}</s-stack>
        <s-stack gap={SPACE.page}>
          {aside.map((child) =>
            // The slot is meaningless now that these are ordinary grid children, and
            // leaving it on would have them looking for a slot no ancestor provides.
            isValidElement(child) ? cloneElement(child, { slot: undefined } as never) : child,
          )}
        </s-stack>
      </s-grid>
    </s-page>
  );
}
