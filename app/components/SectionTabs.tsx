import { Link, useLocation, useSearchParams } from "react-router";

import { HAIRLINE, PAD, SPACE } from "../lib/ui/spacing";

export interface SectionTab {
  href: string;
  label: string;
  /** Shown beside the label. Zero is not shown — an empty count is noise. */
  badge?: number;
}

/**
 * Sub-navigation for a section that gathers several former top-level routes.
 *
 * One component for prices, imports and settings. There were two — `SectionNav` and
 * `PricesTabs`, written a few tickets apart, differing in whether they carried the query
 * string. Two components doing one job, drifting in exactly the way this epic exists to
 * stop, is not a thing to leave in the codebase that is fixing it.
 *
 * **The links carry the query string.** Searching for a SKU on one tab and switching to
 * another is a merchant asking about that SKU, not asking to start again. `page` is
 * dropped: page 4 of one tab is not page 4 of the next, and landing on an empty page
 * reads as "nothing here" rather than "wrong page".
 *
 * The current tab is matched exactly, never by prefix. A section root like `/app/prices`
 * prefixes every other tab in its section, so `startsWith` would light up the first tab
 * on every page.
 *
 * ## Why it now looks like navigation
 *
 * It used to be five links in a row with the current one in bold — no shape, no rule, no
 * indication that the row was a control rather than a sentence. Three things fix that,
 * and all three are structural rather than decorative:
 *
 * - **A rule underneath.** It closes the row, which is what makes it read as a bar
 *   sitting above the content instead of the first line of it.
 * - **The current tab is a filled pill**, not just bold text. Weight alone is a weak
 *   signal in a row where every other item is a coloured link, and "which of these five
 *   views am I looking at" is the one question this component exists to answer.
 * - **Every tab is padded to the same box**, current or not, so nothing shifts when the
 *   selection moves. Padding only the selected one makes the row twitch on every click.
 *
 * ## Why these stay links
 *
 * Polaris web components have **no tabs element** — the tag list contains `s-table*` and
 * nothing else matching. `Tabs` lives in `@shopify/polaris`, the React library, which
 * this app does not use: the `s-*` elements are rendered by Shopify's own runtime and
 * there is no Polaris stylesheet loaded, so React Polaris would render unstyled and put
 * two design systems in one app.
 *
 * `accessibilityRole` is no help either — it accepts `main | header | footer | section |
 * aside | navigation | ordered-list | list-item`, and no `tab` or `tablist`.
 *
 * That constraint happens to point at the right answer. These move between URLs, and
 * ARIA tabs are for switching panels *within* a page — a tablist here would be
 * semantically wrong even if it were available. `navigation` is the role that fits, and
 * Polaris provides it. Keeping real links also keeps middle-click, open-in-new-tab and
 * copy-link-address working, which a button cannot do.
 */
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();

  const carried = new URLSearchParams(params);
  carried.delete("page");
  const query = carried.toString();

  return (
    <s-box
      // A navigation landmark, which is what a row of links between URLs actually is.
      // Screen readers can jump to it, and it stops the row being announced as loose
      // links in the middle of the page content.
      accessibilityRole="navigation"
      accessibilityLabel="Sections"
      // Only the block-end edge carries a width, so this is a rule under the row rather
      // than a box around it. Polaris orders the four values block-start, block-end,
      // inline-start, inline-end -- not the CSS order, which is the easy thing to get
      // wrong here and produces a line down the left of the page instead.
      borderWidth="none base none none"
      borderStyle={HAIRLINE.borderStyle}
      borderColor={HAIRLINE.borderColor}
      paddingBlockEnd={SPACE.item}
    >
      <s-stack direction="inline" gap={SPACE.item} alignItems="center">
        {tabs.map((tab) => {
          const current = pathname === tab.href;
          const label = tab.badge ? `${tab.label} (${tab.badge})` : tab.label;

          return current ? (
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
              <s-text type="strong">{label}</s-text>
              <s-text accessibilityVisibility="exclusive"> (current section)</s-text>
            </s-box>
          ) : (
            <s-box key={tab.href} padding={PAD.control}>
              <Link to={query ? `${tab.href}?${query}` : tab.href}>{label}</Link>
            </s-box>
          );
        })}
      </s-stack>
    </s-box>
  );
}
