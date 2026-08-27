/**
 * The page shell, and the aside it has to rebuild.
 *
 * Polaris renders `s-page`'s `aside` slot **only** at `inlineSize="base"`. Going full
 * width therefore deletes every aside — silently, with no error and no empty box.
 * Nineteen sections across thirteen routes are in that slot, and four of them are on
 * the campaign page, including the one holding apply, revert, resume and cancel.
 *
 * So these assertions are about a merchant losing a button, not about layout taste.
 *
 * Server rendering rather than a DOM: Polaris web components are custom elements the
 * server passes through as written, which is exactly what needs asserting about
 * `inlineSize` and about where the aside content ended up.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

describe("pages without an aside", () => {
  const html = render(
    <PageShell heading="Activity">
      <s-section>just rows</s-section>
    </PageShell>,
  );

  it("put their sections straight into the page, with no wrapper", () => {
    // Not a style preference. Wrapping them — in an `s-stack`, and then in a
    // single-column `s-grid` — rendered the page blank in the admin: heading present,
    // every section gone, no error. Both were found by opening the page, so this
    // assertion is the only thing standing between the next tidy-up and a blank page.
    expect(html).not.toContain("<s-grid");
    expect(html).not.toContain("<s-stack");
    expect(html).toContain("just rows");
  });

  it("still render their content", () => {
    expect(html).toContain("just rows");
  });
});

describe("asides that a page renders conditionally", () => {
  // Three of the nineteen sit inside a ternary — `{count > 0 ? <s-section slot="aside">`
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

    expect(html).not.toContain("<s-grid");
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
