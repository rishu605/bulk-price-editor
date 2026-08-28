import { Children, cloneElement, isValidElement, type ReactNode } from "react";

import { ActionRow } from "./ActionRow";
import { PAGE_INSET, SPACE } from "../lib/ui/spacing";

/**
 * How much of the frame a page occupies, leaving a tenth on each side.
 *
 * A percentage rather than a maximum in pixels, deliberately: the admin renders this app
 * in an iframe whose width is not the window's and changes with the merchant's own
 * sidebar, so a fixed column would be a different fraction of the frame on every screen.
 */
const PAGE_WIDTH = "80%";

/**
 * The inset itself, for the things that sit outside a page and still have to line up
 * with one.
 *
 * There is exactly one: a section's tab bar is rendered by the layout route, above the
 * `Outlet` that renders the page, so it is not inside any `PageShell`. Left alone it ran
 * edge to edge while the page below it started a tenth of the way in — the tabs and the
 * card they belong to visibly detached from each other.
 *
 * Both are 80% of the same parent, so they align rather than nesting: this does not
 * inset something already inset.
 */
export function PageWidth({ children }: { children: ReactNode }) {
  // A grid because `justifyItems` is how a box gets centred here; boxes take padding but
  // not margins, so `margin: auto` is not available.
  return (
    <s-grid justifyItems="center">
      <s-box inlineSize={PAGE_WIDTH}>{children}</s-box>
    </s-grid>
  );
}

/**
 * Every page in the app, at four fifths of the screen.
 *
 * `s-page` defaults to `inlineSize="base"`, a ~660px column. On a 1300px viewport that
 * left roughly half the screen empty while the tables inside it wrapped — which is a
 * strange thing for an app whose whole job is showing a merchant thousands of rows.
 *
 * ## Why 80% and not the whole frame
 *
 * `large` is edge to edge, and edge to edge turned out to be the other mistake: cards
 * that touch both sides of the window have nothing holding them, and a heading pinned to
 * the far left of a 1900px screen is a long way from the first card it names. A tenth of
 * the frame on each side is enough to make the page read as a page.
 *
 * Polaris offers `small`, `base` and `large` and nothing between, so the inset is a
 * centred box wrapping the whole `s-page` — the heading included. Insetting only the
 * content leaves the title hanging off the left edge, aligned to nothing.
 *
 * The catch that makes this more than one attribute: Polaris renders the `aside` slot
 * **only** when `inlineSize` is `"base"`. Nineteen sections were in that slot when this
 * was written, including the one on the campaign page holding apply, revert, resume and
 * cancel. Setting `inlineSize="large"` and nothing else would have deleted the apply
 * button with no error and no empty box, which is the kind of failure nobody finds until
 * a merchant reports it.
 *
 * So the aside is rebuilt here rather than abandoned. Children marked `slot="aside"`
 * are partitioned out and rendered in a second column, and the routes keep writing
 * exactly what they wrote before. The alternative — hand-editing nineteen JSX blocks
 * out of their pages and into a prop — is the same change with far more opportunity to
 * drop one.
 *
 * ## What is allowed in the column
 *
 * Four sections across three routes, now: the store card, recent activity, cost coverage
 * and errors by kind. All four are **facts about this shop**.
 *
 * That is the rule, and it is worth stating because the column had drifted the other way.
 * Ten of the nineteen were prose explaining how the app works — what a baseline is, how
 * two campaigns resolve — and prose does not vary, so those pages spent a permanent 22rem
 * column, full height, on a paragraph a merchant reads once. On the catalogue that meant
 * seven columns of prices compressed into two thirds of the screen so three paragraphs
 * could have the other third. Those are `HelpNote`s at the foot of their pages now; the
 * reasoning is in that file.
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
/**
 * The way back, above the title.
 *
 * Above rather than beside: `s-page` renders its own heading and takes no slot for this
 * in the version pinned here, and a back link under the title would read as the first
 * thing *in* the page rather than as the way out of it. The padding matches what `s-page`
 * insets its own contents by, so it lines up with the heading below it.
 */
function BackLink({ backTo }: { backTo?: { href: string; label: string } }) {
  if (!backTo) return null;

  return (
    <s-box paddingInline={PAGE_INSET}>
      <ActionRow>
        <s-button variant="tertiary" icon="arrow-left" href={backTo.href}>
          {backTo.label}
        </s-button>
      </ActionRow>
    </s-box>
  );
}

export function PageShell({
  heading,
  backTo,
  children,
}: {
  heading: string;
  /**
   * Where this page came from, for pages the nav menu cannot reach.
   *
   * A campaign, the campaign editor and the activity log are all opened *from* somewhere
   * and have no entry of their own, so until this existed the only ways back were the
   * browser's button and guessing which nav item was the parent. On a form that is not
   * merely inconvenient: a merchant who has typed a rule and a scope, and cannot see a
   * way back, will find one that loses it.
   *
   * Pages inside a tabbed section do not take this. Their tab bar is already the way
   * back, and a second one above it would be two answers to one question.
   */
  backTo?: { href: string; label: string };
  children: ReactNode;
}) {
  const all = Children.toArray(children);
  const isAside = (child: ReactNode) =>
    isValidElement(child) && (child.props as { slot?: string }).slot === "aside";

  const aside = all.filter(isAside);
  const main = all.filter((child) => !isAside(child));

  if (aside.length === 0) {
    // Children go straight into `s-page`, with no wrapper of any kind.
    //
    // This looks inconsistent with the two-column branch below, which wraps its columns
    // in stacks, and it is deliberate. Wrapping here — in an `s-stack`, and then in a
    // single-column `s-grid` — rendered the page *blank* in the admin: the heading
    // appeared and every section vanished, with no error and nothing in the console.
    // Both were caught by opening the page; neither was caught by a test, because the
    // markup serialises fine and Polaris' layout only runs in the browser.
    //
    // So `s-page` owns the spacing between its own direct sections, and the page rhythm
    // in `spacing.ts` applies to content this component nests deliberately. Do not
    // "tidy" this into matching the branch below without loading a page that has no
    // aside — `/app/prices/live` is one — and looking at it.
    return (
      <PageWidth>
        <BackLink backTo={backTo} />
        <s-page heading={heading} inlineSize="large">
          {main}
        </s-page>
      </PageWidth>
    );
  }

  return (
    <PageWidth>
      <BackLink backTo={backTo} />
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
    </PageWidth>
  );
}
