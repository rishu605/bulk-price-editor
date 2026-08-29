/**
 * The page shell, and the aside it has to rebuild.
 *
 * Polaris renders `s-page`'s `aside` slot **only** at `inlineSize="base"`. Going full
 * width therefore deletes every aside — silently, with no error and no empty box. That
 * was nineteen sections when this landed, including the one on the campaign page holding
 * apply, revert, resume and cancel. It is four now — the column is reserved for facts
 * about the shop, and the prose that used to fill it is in `HelpNote` — which changes the
 * arithmetic and none of the reasoning.
 *
 * So these assertions are about a merchant losing a button, not about layout taste.
 *
 * Server rendering rather than a DOM: Polaris web components are custom elements the
 * server passes through as written, which is exactly what needs asserting about
 * `inlineSize` and about where the aside content ended up.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { HelpNote } from "./HelpNote";
import { PageShell } from "./PageShell";

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("full width", () => {
  it("asks for the whole screen rather than the default column", () => {
    const html = render(
      <PageShell heading="Prices">
        <s-section>rows</s-section>
      </PageShell>,
    );

    expect(html).toContain('inlineSize="large"');
  });

  it("keeps the heading", () => {
    expect(render(<PageShell heading="Diagnostics">{null}</PageShell>)).toContain(
      'heading="Diagnostics"',
    );
  });
});

describe("the aside survives going full width", () => {
  const html = render(
    <PageShell heading="Campaign">
      <s-section heading="Preview">main content</s-section>
      <s-section slot="aside" heading="Actions">
        <s-button>Apply</s-button>
      </s-section>
    </PageShell>,
  );

  it("still renders the aside content", () => {
    expect(html, "an aside dropped here is a button a merchant cannot press").toContain(
      "Apply",
    );
  });

  it("still renders the main content", () => {
    expect(html).toContain("main content");
  });

  it("puts it in a second column rather than leaving it to the slot", () => {
    expect(html).toContain("<s-grid");
  });

  it("drops the slot, which now names a slot no ancestor provides", () => {
    expect(html).not.toContain('slot="aside"');
  });

  it("keeps main content ahead of the aside, so narrow screens read in order", () => {
    expect(html.indexOf("main content")).toBeLessThan(html.indexOf("Apply"));
  });
});

describe("the help note, wherever the route wrote it", () => {
  /**
   * Position is the shell's decision, not the route's. It shipped at the foot of the page
   * for one release — which puts the answer to "what does this column mean?" below the
   * column being asked about, so a merchant has to leave the question to reach it.
   *
   * Both branches are checked because they build the main column differently, and a fix
   * applied to one of them is exactly the kind of thing that looks done.
   */
  it("renders under the title, above the content, on a page with no aside", () => {
    const html = render(
      <PageShell heading="Catalogue">
        <s-section>the table</s-section>
        <HelpNote label="What these mean">
          <s-paragraph>a definition</s-paragraph>
        </HelpNote>
      </PageShell>,
    );

    expect(html.indexOf("What these mean")).toBeLessThan(html.indexOf("the table"));
  });

  it("renders under the title on a page that has one", () => {
    const html = render(
      <PageShell heading="Home">
        <s-section>the table</s-section>
        <HelpNote label="What these mean">
          <s-paragraph>a definition</s-paragraph>
        </HelpNote>
        <s-section slot="aside">store</s-section>
      </PageShell>,
    );

    expect(html.indexOf("What these mean")).toBeLessThan(html.indexOf("the table"));
  });

  it("is taken out of the main flow rather than rendered twice", () => {
    const html = render(
      <PageShell heading="Catalogue">
        <s-section>the table</s-section>
        <HelpNote label="What these mean">
          <s-paragraph>a definition</s-paragraph>
        </HelpNote>
      </PageShell>,
    );

    expect(html.split("What these mean").length - 1, "the note is rendered twice").toBe(1);
  });
});

describe("pages without an aside", () => {
  const html = render(
    <PageShell heading="Activity">
      <s-section>just rows</s-section>
    </PageShell>,
  );

  it("put their sections straight into the page, with no wrapper inside it", () => {
    // Not a style preference. Wrapping them — in an `s-stack`, and then in a
    // single-column `s-grid` — rendered the page blank in the admin: heading present,
    // every section gone, no error. Both were found by opening the page, so this
    // assertion is the only thing standing between the next tidy-up and a blank page.
    //
    // *Inside* is the whole rule. The page itself sits in a centring box that insets it
    // to 80% of the frame, and that is outside `s-page` where it does no harm — checked
    // by rendering it against the real Polaris components. What must not happen is
    // anything coming between `s-page` and its sections.
    expect(html).toMatch(/<s-page[^>]*>\s*<s-section/);
    expect(html).toContain("just rows");
  });

  it("still render their content", () => {
    expect(html).toContain("just rows");
  });
});

describe("asides that a page renders conditionally", () => {
  // Some sit inside a ternary — `{count > 0 ? <s-section slot="aside">`
  // — so they arrive as a direct child only when the condition holds. A partition that
  // missed them would drop an aside on exactly the pages that had something to say.
  it("are found when the condition holds", () => {
    const show = true;
    const html = render(
      <PageShell heading="Diagnostics">
        <s-section>main</s-section>
        {show ? <s-section slot="aside">by kind</s-section> : null}
      </PageShell>,
    );

    expect(html).toContain("by kind");
    expect(html).toContain("<s-grid");
  });

  it("leave no empty column when the condition does not hold", () => {
    const show = false;
    const html = render(
      <PageShell heading="Diagnostics">
        <s-section>main</s-section>
        {show ? <s-section slot="aside">by kind</s-section> : null}
      </PageShell>,
    );

    expect(html).toMatch(/<s-page[^>]*>\s*<s-section/);
  });
});

describe("the column collapses before it gets unreadable", () => {
  const html = render(
    <PageShell heading="X">
      <s-section>main</s-section>
      <s-section slot="aside">side</s-section>
    </PageShell>,
  );

  const columns = /gridTemplateColumns="([^"]+)"/i.exec(html)?.[1] ?? "";

  it("uses a container query, because the admin iframe is not the window", () => {
    expect(columns).toMatch(/^@container[^)]*inline-size/);
  });

  it("carries exactly one comma, which is the separator and not part of a value", () => {
    // This is the assertion that was missing, and its absence let a broken value
    // through: `minmax(0, 1fr)` reads its own comma as the branch separator, so the
    // value stops parsing and Polaris falls back to `none` -- one column, aside
    // stacked underneath, indistinguishable from a deliberate layout.
    expect(
      columns.split(",").length - 1,
      `"${columns}" has a comma inside a value, so Polaris cannot parse it`,
    ).toBe(1);
  });

  it("asks for two columns when there is room", () => {
    const [, wide] = columns.split(",");
    expect(wide.trim().split(/\s+/), "wide viewports get content plus an aside").toHaveLength(2);
  });
});

describe("the inset", () => {
  const html = render(
    <PageShell heading="Anchor">
      <s-section>rows</s-section>
    </PageShell>,
  );

  it("leaves a tenth of the frame on each side", () => {
    expect(html).toContain('inlineSize="80%"');
  });

  it("insets the heading with the content, not just the content", () => {
    // A title pinned to the far left of a 1900px screen, with the first card it names
    // starting a tenth of the way in, reads as two unrelated things. So the box wraps
    // the whole page rather than its children.
    expect(html.indexOf('inlineSize="80%"')).toBeLessThan(html.indexOf("<s-page"));
  });
});

describe("what the inset must not break", () => {
  it("keeps the aside, which only exists because this component rebuilds it", () => {
    // The inset wraps `s-page` from outside. If a future tidy-up moves it inside, the
    // aside partitioning still runs but Polaris has no aside slot at `large` — and the
    // sections land in a slot nothing renders, which is how they disappear.
    const html = render(
      <PageShell heading="Anchor">
        <s-section heading="Catalogue">main</s-section>
        <s-section slot="aside" heading="Store">sidebar</s-section>
      </PageShell>,
    );

    expect(html).toContain("sidebar");
    expect(html, "a section still asking for a slot is a section nobody sees").not.toContain(
      'slot="aside"',
    );
  });
});

describe("every page in the app goes through the shell", () => {
  const APP = join(process.cwd(), "app");

  const sources = (dir: string): Array<{ path: string; text: string }> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
      return [{ path: path.replace(`${APP}/`, ""), text: sourceOf(path) }];
    });

  /**
   * The two surfaces that are deliberately not admin pages.
   *
   * `auth.login` is the shop-domain form served *outside* the Shopify admin, where
   * `s-page`'s own narrow column is right for a single field and 80% of a browser window
   * is not. `help.$` is the public help centre: plain HTML, its own shell, no Polaris.
   */
  const NOT_ADMIN_PAGES = ["routes/auth.login/route.tsx", "routes/help.$.tsx"];

  it("leaves no page rendering s-page for itself", () => {
    // A page that misses the shell is edge to edge while every other page is inset, and
    // — because Polaris only renders the real aside slot at `inlineSize="base"` — it
    // silently drops any aside it has.
    const bare = sources(APP)
      .filter(({ path }) => path !== "components/PageShell.tsx")
      .filter(({ path }) => !NOT_ADMIN_PAGES.includes(path))
      .filter(({ text }) => text.includes("<s-page"))
      .map(({ path }) => path);

    expect(bare, "render these through PageShell so they inset and keep their aside").toEqual(
      [],
    );
  });

  it("insets the one thing that renders outside a page", () => {
    // A section's tabs come from the layout route, above the `Outlet`. They are the only
    // markup in the app that has to line up with a page without being inside one.
    const tabs = sourceOf(APP, "components", "SectionTabs.tsx");

    expect(tabs).toContain("PageWidth");
  });
});

describe("the way back", () => {
  it("is offered on a page the nav menu cannot reach", () => {
    // A campaign, the editor and the activity log are opened *from* somewhere and have no
    // nav entry. Before this the only ways back were the browser's button and guessing
    // which nav item was the parent.
    const html = render(
      <PageShell heading="Summer sale" backTo={{ href: "/app/campaigns", label: "Campaigns" }}>
        <s-section>detail</s-section>
      </PageShell>,
    );

    expect(html).toContain('href="/app/campaigns"');
    expect(html).toContain("Campaigns");
    expect(html).toContain('icon="arrow-left"');
  });

  it("sits above the title rather than inside the page", () => {
    // Under the heading it reads as the first thing *in* the page rather than the way
    // out of it, and `s-page` takes no slot for one in this version.
    const html = render(
      <PageShell heading="Summer sale" backTo={{ href: "/app/campaigns", label: "Campaigns" }}>
        <s-section>detail</s-section>
      </PageShell>,
    );

    expect(html.indexOf('href="/app/campaigns"')).toBeLessThan(html.indexOf("<s-page"));
  });

  it("is absent on a page that has a tab bar, which is already the way back", () => {
    const html = render(
      <PageShell heading="Variants">
        <s-section>rows</s-section>
      </PageShell>,
    );

    expect(html).not.toContain('icon="arrow-left"');
  });
});

describe("pages that can lose typed work", () => {
  const APP_ROUTES = join(process.cwd(), "app", "routes");

  /**
   * A page holding fields nobody has saved yet needs the guard, or its own back link
   * becomes the fastest way to throw the work away.
   *
   * Settings is exempt: it has the App Bridge save bar, which blocks navigation itself.
   * Recapture is exempt: its one field is a typed confirmation that costs a second to
   * retype, and the page it guards is destructive enough that leaving is the good outcome.
   */
  const GUARDED = [
    "app.campaigns.new.tsx",
    // A price file makes a campaign, so it moved to campaigns; the other two moved onto
    // the pages that list the thing they write. The guard travelled with each of them —
    // which is the point of listing the routes here rather than the section they used to
    // share.
    // The price import's form is in the campaign editor now (#445); the old URL is a
    // redirect with nothing to type into.
    "app.campaigns.new.tsx",
    "app.prices.baselines._index.tsx",
    "app.prices.costs.tsx",
  ];

  /**
   * A route satisfies this by rendering the guard itself, or by rendering the shared
   * `ImportForm`, which does.
   *
   * The indirection is checked rather than assumed: the assertion below pins the guard
   * inside `ImportForm`, so "route renders ImportForm" is only accepted while ImportForm
   * is still the thing that guards.
   */
  const PROVIDERS = ["<UnsavedChanges", "<ImportForm"];

  it("the shared import form carries the guard the routes delegate to it", () => {
    const form = sourceOf("app", "components", "imports", "ImportForm.tsx");

    expect(form).toContain("<UnsavedChanges");
  });

  it("guard the ones that hold a form worth keeping", () => {
    const missing = GUARDED.filter((route) => {
      const source = sourceOf(APP_ROUTES, route);
      return !PROVIDERS.some((provider) => source.includes(provider));
    });

    expect(missing, "these can discard a filled-in form on any navigation").toEqual([]);
  });
});

describe("how wide the second column is", () => {
  // `<=` arrives HTML-escaped from `renderToStaticMarkup`, which is correct output and
  // noise here — the assertions are about the track list, not about entity encoding.
  const columnsOf = (html: string) =>
    (/gridtemplatecolumns="([^"]*)"/i.exec(html)?.[1] ?? "").replaceAll("&lt;", "<");

  const page = (asideWidth?: "base" | "wide") =>
    render(
      <PageShell heading="Campaign" {...(asideWidth ? { asideWidth } : {})}>
        <s-section heading="Rule">main content</s-section>
        <s-section slot="aside" heading="Preview">rows</s-section>
      </PageShell>,
    );

  it("defaults to the narrow strip every other page wants", () => {
    expect(columnsOf(page())).toBe("@container (inline-size <= 900px) 1fr, 1fr 22rem");
  });

  it("gives the campaign editor's price table half the page", () => {
    // A preview of prices at 22rem wraps every row onto three lines, and a preview a
    // merchant has to decode is not a preview.
    expect(columnsOf(page("wide"))).toBe("@container (inline-size <= 900px) 1fr, 1fr 1fr");
  });

  it("never puts a second comma in the value", () => {
    // Polaris splits a responsive grid value on the comma to separate "when the query
    // matches" from "otherwise". The obvious `minmax(0, 1fr)` brings its own comma, the
    // whole value stops parsing, and the aside silently stacks underneath — which looks
    // exactly like a layout choice rather than a broken string.
    for (const width of ["base", "wide"] as const) {
      expect(
        columnsOf(page(width)).split(",").length - 1,
        `the ${width} column value has a comma inside a track, so it will not parse`,
      ).toBe(1);
    }
  });
});
