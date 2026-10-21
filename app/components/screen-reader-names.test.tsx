/**
 * What the eye gets from a glyph, a strike-through, a dash or an icon, a screen reader
 * gets in words (#798).
 *
 * Each of these was correct to look at and wrong to listen to:
 *
 * - every count tile's figure was a heading, so heading navigation on Home listed "3,669",
 *   "0", "12" as the page's outline;
 * - an onboarding step's state was a glyph with no name, and its three "Why?" toggles had
 *   one name between them and no expanded state;
 * - a compare-at price was `<s>`, which the major screen readers do not announce by
 *   default, so a listener heard two prices with no cue which was the old one;
 * - the em dash that means *No* in the plan table was read as "em dash", or skipped;
 * - a link that opens a new tab said so only with a decorative icon, or not at all.
 *
 * Rendered to static markup like the other component tests; the source scans at the end
 * are what stop the next one of each being written the old way.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BaselineTable } from "./BaselineTable";
import { Blank } from "./Blank";
import { CountsRow } from "./CountsRow";
import { ErrorScreen } from "./ErrorScreen";
import { MoneyCell } from "./MoneyCell";
import { OnboardingCard } from "./OnboardingCard";
import { ReconciliationTable } from "./ReconciliationTable";
import { StorefrontExample } from "./StorefrontExample";
import { onboarding } from "../lib/onboarding/steps";
import { NEW_TAB, newTabName } from "../lib/ui/new-tab";
import { sourceFiles, sourceOf } from "../lib/testing/source";
import type { BaselineRow } from "../services/baseline-browser.server";
import type { DraftPreviewRow } from "../services/campaigns/draft-preview.server";
import type { ReconciliationRow } from "../services/reconciliation.server";

describe("count tiles", () => {
  const html = renderToStaticMarkup(
    <CountsRow
      items={[
        { label: "Variants", value: 3_669 },
        { label: "Need attention", value: 3, href: "/app/prices/drift" },
        { label: "Oldest baseline captured", value: "27 Aug 2026" },
      ]}
    />,
  );

  it("draw their figures large without making each one a heading", () => {
    const headings = html.match(/<s-heading\b[^>]*>/g) ?? [];

    expect(headings, "the tiles stopped rendering their figures").toHaveLength(3);
    for (const tag of headings) {
      expect(tag, "a figure in the page outline is noise: say role none").toContain('accessibilityRole="none"');
    }
  });

  it("still show the figure", () => {
    expect(html).toContain(">3,669</s-heading>");
  });
});

describe("the onboarding checklist", () => {
  const html = renderToStaticMarkup(
    <OnboardingCard
      state={onboarding({ hasBaselines: true, hasCampaign: false, hasPracticed: false, hasCleanRun: false })}
    />,
  );

  /** The markup from one step's title to the next step's. */
  const step = (title: string, next?: string) =>
    html.slice(html.indexOf(title) - 200, next ? html.indexOf(next) - 200 : undefined);

  it("says which steps are done in words, not only with a glyph", () => {
    // The checked circle and the dashed one are `s-icon`, which takes no label.
    expect(html).toMatch(/<s-text accessibilityVisibility="exclusive">Done: <\/s-text>Capture your baselines/);
    expect(html).toMatch(/<s-text accessibilityVisibility="exclusive">To do: <\/s-text>Try one in practice mode/);
    expect(html).toMatch(/<s-text accessibilityVisibility="exclusive">To do: <\/s-text>Run your first real campaign/);
  });

  it("gives each Why? a name of its own", () => {
    // Three buttons called "Why?" are three identical entries in a screen reader's list
    // of controls.
    const names = [...html.matchAll(/<s-button[^>]*accessibilityLabel="([^"]*)"[^>]*>Why\?<\/s-button>/g)].map(
      (match) => match[1],
    );

    expect(names).toEqual(["Why try one in practice mode?", "Why run your first real campaign?"]);
  });

  it("opens each Why? with the platform's own disclosure, which reports whether it is expanded", () => {
    // Polaris sets `aria-expanded` on a button whose `commandFor` names a popover, from the
    // popover's open state. A React-state toggle on `s-button` has no way to: the button
    // that takes focus is inside the element's shadow root, out of reach of an attribute.
    const why = [...html.matchAll(/<s-button([^>]*)>Why\?<\/s-button>/g)].map((match) => match[1]);
    const popovers = [...html.matchAll(/<s-popover[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);

    expect(why).toHaveLength(2);
    expect(new Set(popovers).size, "each Why? needs its own popover id").toBe(2);
    why.forEach((attrs, index) => {
      expect(attrs).toContain(`commandFor="${popovers[index]}"`);
      expect(attrs, "a popover activator without a command is inert").toContain('command="--toggle"');
    });
  });

  it("keeps each step's reasoning with its own step", () => {
    expect(step("Try one in practice mode", "Run your first real campaign")).toContain("writes absolutely nothing");
    expect(step("Run your first real campaign")).toContain("Start small");
  });
});

const tee = (over: Partial<DraftPreviewRow> = {}): DraftPreviewRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Cotton tee · M",
  imageUrl: null,
  before: "$24.00",
  live: null,
  after: "$19.20",
  beforeCompareAt: null,
  afterCompareAt: "$24.00",
  unchanged: false,
  skippedReason: null,
  ...over,
});

/** The struck-through elements in some markup. */
const struck = (html: string) => html.match(/type="redundant"/g) ?? [];

describe("an old price", () => {
  it("is called the old price in a table cell, not only struck through", () => {
    const html = renderToStaticMarkup(<MoneyCell amount="$19.20" compareAt="$24.00" />);

    expect(html).toMatch(
      /<s-text[^>]*type="redundant"[^>]*><s-text accessibilityVisibility="exclusive">was <\/s-text>\$24\.00<\/s-text>/,
    );
  });

  it("is called the old price on the storefront example too", () => {
    const html = renderToStaticMarkup(<StorefrontExample row={tee()} />);

    expect(struck(html)).toHaveLength(1);
    expect(html).toMatch(
      /<s-text[^>]*type="redundant"[^>]*><s-text accessibilityVisibility="exclusive">was <\/s-text>\$24\.00<\/s-text>/,
    );
  });

  it("is struck through in one component, so every strike-through carries the word", () => {
    const users = sourceFiles("app/routes", "app/components")
      .filter((file) => sourceOf(file).includes('type="redundant"'));

    expect(users, "strike prices through with OldPrice from MoneyCell").toEqual(["app/components/MoneyCell.tsx"]);
  });
});

describe("an em dash", () => {
  it("is read as None rather than as punctuation", () => {
    const html = renderToStaticMarkup(<Blank />);

    expect(html).toContain('<s-text accessibilityVisibility="hidden">—</s-text>');
    expect(html).toContain('<s-text accessibilityVisibility="exclusive">None</s-text>');
  });

  it("says No where the column is a yes or no", () => {
    expect(renderToStaticMarkup(<Blank means="No" />)).toContain(
      '<s-text accessibilityVisibility="exclusive">No</s-text>',
    );

    const plan = sourceOf("app/routes/app.settings.plan.tsx");
    expect(plan).toContain('plan.markets ? "Yes" : <Blank means="No" />');
    expect(plan).toContain('plan.b2b ? "Yes" : <Blank means="No" />');
  });
});

describe("a link that opens a new tab", () => {
  it("says so in its name", () => {
    expect(newTabName("Open Cotton tee in Shopify")).toBe(`Open Cotton tee in Shopify ${NEW_TAB}`);
    expect(NEW_TAB).toBe("(opens in a new tab)");
  });

  it("says so on the baseline table's Shopify link", () => {
    const html = renderToStaticMarkup(
      <BaselineTable
        rows={[
          {
            variantGid: "gid://shopify/ProductVariant/1",
            productGid: "gid://shopify/Product/1",
            title: "Cotton tee",
            sku: null,
            vendor: null,
            baseline: "$24.00",
            live: "$24.00",
            source: null,
            capturedAt: null,
            diverged: false,
            adminUrl: "https://admin.shopify.com/store/x/products/1",
          } satisfies BaselineRow,
        ]}
        onShowHistory={() => undefined}
      />,
    );

    expect(html).toMatch(/<s-button[^>]*target="_blank"[^>]*accessibilityLabel="Open Cotton tee in Shopify \(opens in a new tab\)"/);
  });

  it("says so on What's live", () => {
    const html = renderToStaticMarkup(
      <ReconciliationTable
        rows={[
          {
            variantGid: "gid://shopify/ProductVariant/1",
            title: "Cotton tee",
            priceListGid: "",
            surface: "Base price",
            live: "$19.20",
            baseline: "$24.00",
            campaignId: null,
            campaignName: null,
            drifted: false,
            offBaseline: true,
            adminUrl: "https://admin.shopify.com/store/x/products/1",
          } as ReconciliationRow,
        ]}
        clearHref="/app/prices/live"
      />,
    );

    expect(html).toContain('accessibilityLabel="Open Cotton tee in Shopify (opens in a new tab)"');
  });

  it("says so on the error screen's help link", () => {
    const html = renderToStaticMarkup(
      <ErrorScreen errorId={null} userMessage="Something went wrong." code="UNKNOWN" retryable={false} />,
    );
    const help = /<s-button([^>]*target="_blank"[^>]*)>/.exec(html)?.[1];

    expect(help, "the error screen lost its help link").toBeDefined();
    expect(help).toMatch(/accessibilityLabel="[^"]+ \(opens in a new tab\)"/);
  });

  it("says so everywhere one is written, except an email address", () => {
    // A mailto opens the mail app, not a tab, and the address it shows says where it goes.
    const offenders = sourceFiles("app/routes", "app/components").flatMap((file) => {
      const source = sourceOf(file);
      return [...source.matchAll(/target="_blank"/g)]
        .map((match) => {
          const start = source.lastIndexOf("<", match.index);
          const end = source.indexOf(">", match.index);
          return source.slice(start, end + 1);
        })
        .filter((tag) => !/mailto|href=\{mailto\}|supportMailto/.test(tag))
        .filter((tag) => !tag.includes("newTabName("))
        .map((tag) => `${file}: ${tag.replace(/\s+/g, " ")}`);
    });

    expect(offenders, "name the link with newTabName() from lib/ui/new-tab").toEqual([]);
  });

  it("finds the links it is protecting", () => {
    const named = sourceFiles("app/routes", "app/components").filter((file) =>
      sourceOf(file).includes("newTabName("),
    );

    expect(named.length).toBeGreaterThanOrEqual(4);
  });
});
