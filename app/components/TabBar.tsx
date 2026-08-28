import type { ComponentProps, ReactNode } from "react";

import { PlainLink } from "./PlainLink";
import { PAD, SPACE } from "../lib/ui/spacing";

export interface Tab {
  /** Where this tab goes. Not rendered as a link when the tab is current. */
  href: string;
  label: string;
  /** Shown beside the label. Zero is not shown — an empty count is noise. */
  badge?: number;
  /**
   * Optional glyph before the label, for tabs that name a *shape* of view rather than a
   * subject: a list versus a calendar. Section tabs do not take one — "Baselines" and
   * "Drift" are subjects, and an icon per subject is decoration.
   */
  icon?: ComponentProps<"s-icon">["type"];
  current: boolean;
}

/**
 * The one tab bar.
 *
 * Three of these had grown independently: the section nav (prices, imports, settings),
 * the campaign page's `?tab=`, and the campaigns index's list/calendar toggle. Only the
 * first looked like a control. Same job, three implementations, drifting apart — that is
 * the pattern this epic exists to stop, so the shape lives here and the callers only
 * decide *what* the tabs are.
 *
 * ## What makes it read as a bar
 *
 * The first version of this component was a filled pill for the current tab and plain
 * text for the others, floating above a rule with a gap between them. Three things were
 * wrong with it, all visible in one screenshot of the campaigns index:
 *
 * - **The pill was a different object from its neighbours.** A grey rounded box beside a
 *   run of bare text does not read as "these are the same control, one of them selected";
 *   it reads as a badge that happens to sit near some links.
 * - **The non-current tabs were browser-blue and underlined.** They are anchors, and an
 *   anchor is painted by the browser unless something stops it. See `PlainLink`.
 * - **The rule was detached.** A gap between the tabs and the line underneath makes the
 *   line a divider between two unrelated things rather than the bar's own baseline.
 *
 * So the current tab is now marked the way tabs have been marked since tabs existed: a
 * **thick indicator sitting directly on the rule**, under a label that is the same size,
 * the same weight box and the same padding as every other label in the row. Nothing moves
 * when the selection changes, because the only thing that changes is which three pixels
 * are dark.
 *
 * The indicator and the rule are adjacent siblings with no gap between them, which is
 * what makes the selected tab look like it is *part of* the line rather than above it.
 *
 * ## The action slot
 *
 * A page's primary action belongs on the same line as its tabs, at the far end. The
 * campaigns index had it in a card of its own above them — a card holding one button and
 * a toggle, mostly empty, which is the shape a page takes when nobody has decided what
 * its header is. Here the row *is* the header: what you are looking at on the left, what
 * you can do about it on the right, one rule under both.
 *
 * ## Why these are links and not buttons
 *
 * Polaris web components have **no tabs element** — all 57 tags, checked against the App
 * Home reference, and there is no `s-tabs` or `s-tab`. `Tabs` lives in `@shopify/polaris`,
 * the React library this app does not use: the `s-*` elements are rendered by Shopify's
 * own runtime with no Polaris stylesheet loaded, so React Polaris would render unstyled
 * and put two design systems in one app.
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
  action,
  preventScrollReset = false,
}: {
  tabs: Tab[];
  /** Names the landmark, so a screen reader hears which bar it has jumped to. */
  label: string;
  /**
   * The page's primary action, rendered at the far end of the row. Optional: a section
   * nav is navigation and nothing else, and an empty column collapses to nothing.
   */
  action?: ReactNode;
  /**
   * Set when the tabs swap a panel on the same route rather than navigating between
   * pages. Scrolling back to the top on a same-page switch throws away the merchant's
   * position for no reason; on a real page change, resetting is what they expect.
   */
  preventScrollReset?: boolean;
}) {
  const row = (
    // No gap between tabs. Each already carries `PAD.control`, so the labels sit a padding
    // apart and the indicators run edge to edge, which is what makes the row read as a bar
    // rather than as spaced-out words -- and it buys back the width that had the campaigns
    // index's six status tabs wrapping.
    <s-stack direction="inline" alignItems="end">
      {tabs.map((tab) => (
        <TabItem key={tab.href} tab={tab} preventScrollReset={preventScrollReset} />
      ))}
    </s-stack>
  );

  return (
    <s-box
      // A navigation landmark, which is what a row of links between URLs actually is.
      // Screen readers can jump to it, and it stops the row being announced as loose
      // links in the middle of the page content.
      accessibilityRole="navigation"
      accessibilityLabel={label}
    >
      {action ? (
        <s-grid
          // The tabs take the space, the action takes what it needs. No comma in the
          // value: Polaris splits a responsive value on the comma, so one that appears
          // inside a `minmax()` silently breaks the whole declaration.
          gridTemplateColumns="1fr auto"
          gap={SPACE.section}
          // Bottom-aligned, so the tab indicators and the action sit on the same baseline
          // however tall either side happens to be.
          alignItems="end"
        >
          {row}
          {/* Lifted off the rule. A button whose border touches the line reads as sitting
              in a box with it. */}
          <s-box paddingBlockEnd={SPACE.item}>{action}</s-box>
        </s-grid>
      ) : (
        // No grid at all without an action, rather than a grid whose second column is
        // empty. An empty track is still a track: the column gap comes off the tabs' width
        // whether or not anything is in the second column, and those sixteen pixels were
        // exactly enough to wrap the campaigns index's last status tab onto a line of its
        // own, below the rule.
        row
      )}

      {/* `s-divider` rather than a border on the box above. Polaris' four-value border
          shorthand is flow-relative and its order is not CSS's, so `none none base none`
          is a coin flip between "a rule underneath" and "a stray vertical line down the
          left" — and the wrong one of those reads as a rendering artefact rather than as
          a mistake, which is why the earlier version of it survived several tickets. A
          divider is one element that means one thing. */}
      <s-divider />
    </s-box>
  );
}

/**
 * One tab.
 *
 * The label box and the indicator are built **once** and rendered by both branches. The
 * previous version wrote the markup out twice, which is how the current tab ended up with
 * padding the others did not have: the row twitched sideways on every click, and nothing
 * in the source made it obvious the two branches were supposed to match. Here they cannot
 * disagree — the only difference between a current tab and a link is whether it is
 * wrapped in an anchor.
 */
function TabItem({
  tab,
  preventScrollReset,
}: {
  tab: Tab;
  preventScrollReset: boolean;
}) {
  const text = tab.badge ? `${tab.label} (${tab.badge})` : tab.label;

  const content = (
    <>
      <s-box padding={PAD.control}>
        <s-stack direction="inline" gap={SPACE.tight} alignItems="center">
          {tab.icon ? (
            <s-icon type={tab.icon} size="small" color={tab.current ? "base" : "subdued"} />
          ) : null}
          {/* Weight is the *supporting* signal here, not the whole of it. The indicator
              below is what actually answers "which one am I on". */}
          <s-text type={tab.current ? "strong" : "generic"}>{text}</s-text>
          {tab.current ? (
            // The indicator says it to everyone who can see it and nothing to anyone who
            // cannot.
            <s-text accessibilityVisibility="exclusive"> (current)</s-text>
          ) : null}
        </s-stack>
      </s-box>

      {/* Always rendered, transparent when the tab is not current — so selecting a tab
          changes a colour and never a height.

          A plain `div` and not an `s-box`, which is the one place this component leaves
          the design system, and only after trying it the other way: `background="strong"`
          is the most intense background Polaris offers and it renders as roughly #ebebeb,
          which against the admin's grey page is invisible. Rendered, the bar had no
          selected tab at all.

          `currentColor` is the point of doing it by hand — the indicator is the label's
          own colour, so it stays correct in whatever theme the admin is painting text in,
          which a hardcoded hex would not. */}
      <div
        style={{
          height: "3px",
          background: tab.current ? "currentColor" : "transparent",
          borderRadius: "3px 3px 0 0",
        }}
      />
    </>
  );

  return tab.current ? (
    // Not a link: the current tab has nowhere to go, and a link to the page you are on is
    // a control that does nothing.
    <s-box>{content}</s-box>
  ) : (
    <PlainLink to={tab.href} preventScrollReset={preventScrollReset}>
      {content}
    </PlainLink>
  );
}
