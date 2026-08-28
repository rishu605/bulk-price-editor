import { Link } from "react-router";

import { HAIRLINE, PAD, SPACE } from "../lib/ui/spacing";

export interface Tab {
  /** Where this tab goes. Not rendered as a link when the tab is current. */
  href: string;
  label: string;
  /** Shown beside the label. Zero is not shown — an empty count is noise. */
  badge?: number;
  current: boolean;
}

/**
 * The one tab bar.
 *
 * Three of these had grown independently: the section nav (prices, imports, settings),
 * the campaign page's `?tab=`, and the campaigns index's list/calendar toggle. Only the
 * first looked like a control. The other two were a bold word beside a blue link, which
 * reads as a sentence with a link in it, not as a choice between views — and the index
 * one wrapped the current view in a link back to the page you were already on.
 *
 * Same job, three implementations, drifting apart. That is the pattern this epic exists
 * to stop, so the shape lives here and the callers only decide *what* the tabs are.
 *
 * ## What makes it read as a bar
 *
 * - **A rule underneath**, which closes the row so it sits above the content rather
 *   than reading as the first line of it.
 * - **The current tab is a filled pill.** Weight alone is a weak signal in a row where
 *   every other item is a coloured link, and "which of these am I looking at" is the
 *   one question this component exists to answer.
 * - **Every tab is padded to the same box**, current or not, so nothing shifts when the
 *   selection moves. Padding only the selected one makes the row twitch on every click.
 *
 * ## Why these are links and not buttons
 *
 * Polaris web components have **no tabs element** — all 57 tags, checked against the
 * App Home reference, and there is no `s-tabs` or `s-tab`. `Tabs` lives in
 * `@shopify/polaris`, the React library this app does not use: the `s-*` elements are
 * rendered by Shopify's own runtime with no Polaris stylesheet loaded, so React Polaris
 * would render unstyled and put two design systems in one app.
 *
 * `accessibilityRole` is no help either — it accepts `main | header | footer | section |
 * aside | navigation | ordered-list | list-item`, and no `tab` or `tablist`.
 *
 * That constraint points at the right answer anyway. Every one of these moves between
 * URLs, and ARIA tabs are for switching panels *within* a page, so a tablist would be
 * semantically wrong even if it existed. `navigation` is the role that fits. Real links
 * also keep middle-click, open-in-new-tab and copy-link-address working, which a button
 * cannot do.
 */
export function TabBar({
  tabs,
  label,
  preventScrollReset = false,
}: {
  tabs: Tab[];
  /** Names the landmark, so a screen reader hears which bar it has jumped to. */
  label: string;
  /**
   * Set when the tabs swap a panel on the same route rather than navigating between
   * pages. Scrolling back to the top on a same-page switch throws away the merchant's
   * position for no reason; on a real page change, resetting is what they expect.
   */
  preventScrollReset?: boolean;
}) {
  return (
    <s-box
      // A navigation landmark, which is what a row of links between URLs actually is.
      // Screen readers can jump to it, and it stops the row being announced as loose
      // links in the middle of the page content.
      accessibilityRole="navigation"
      accessibilityLabel={label}
      // Only the block-end edge carries a width, so this is a rule under the row rather
      // than a box around it.
      //
      // The order is `block-start inline-end block-end inline-start` -- CSS clock order,
      // just flow-relative. This said `none base none none` from P7.6 until it was seen
      // in a browser, which put a faint vertical line down the right of every section
      // tab bar and no rule anywhere. It looked like nothing rather than like a mistake,
      // which is why it survived: the assertion checked that a border was set, not which
      // edge got it, and neither does a glance at the page.
      borderWidth="none none base none"
      borderStyle={HAIRLINE.borderStyle}
      borderColor={HAIRLINE.borderColor}
      paddingBlockEnd={SPACE.item}
    >
      <s-stack direction="inline" gap={SPACE.item} alignItems="center">
        {tabs.map((tab) => {
          const text = tab.badge ? `${tab.label} (${tab.badge})` : tab.label;

          return tab.current ? (
            <s-box
              key={tab.href}
              padding={PAD.control}
              borderRadius="base"
              background="subdued"
            >
              {/* Not a link: the current tab has nowhere to go, and a link to the page
                  you are on is a control that does nothing. The visually hidden word is
                  what tells a screen-reader user which one is selected — the filled pill
                  says it to everyone else and says nothing to them. */}
              <s-text type="strong">{text}</s-text>
              <s-text accessibilityVisibility="exclusive"> (current)</s-text>
            </s-box>
          ) : (
            <s-box key={tab.href} padding={PAD.control}>
              {/* The label goes through `s-text` because a react-router `Link` renders a
                  bare `<a>`, and a bare anchor is painted by the browser: these tabs were
                  the last browser-blue underlined links in the app, and the only ones the
                  `s-link` sweep could not see.

                  Still a `Link` and not an `s-button href`, which would be the vocabulary
                  answer everywhere else. A button is an anchor, so it navigates by loading
                  the document again — and these tabs swap a view several times a minute.
                  Client-side routing is worth an underline. */}
              <Link to={tab.href} preventScrollReset={preventScrollReset}>
                <s-text>{text}</s-text>
              </Link>
            </s-box>
          );
        })}
      </s-stack>
    </s-box>
  );
}
