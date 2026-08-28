/**
 * The explanations survived being folded into an overlay.
 *
 * Ten pages had their teaching prose in an `s-section slot="aside"` — a permanent 22rem
 * column, full height, next to the table the merchant came for. Three things can go
 * wrong in moving it, and only the first is loud:
 *
 * - the popover has no activator, so the prose is unreachable — the button and the
 *   overlay are linked by an id, and an id that does not match is silent;
 * - the note drifts back down the page. It shipped at the foot for one release, which put
 *   the answer below the thing being asked about; `PageShell` decides the position now,
 *   and this pins it there;
 * - a paragraph is dropped during the move. Nothing errors, nothing looks wrong, and the
 *   page simply stops explaining what a baseline is. `sections.test.ts` guards the same
 *   failure for the campaign tabs, and for the same reason.
 *
 * So the render assertions cover the mechanism and a source scan covers the content: each
 * page still names the thing it used to explain, wherever that prose now lives.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HelpNote } from "./HelpNote";

const ROUTES = join(process.cwd(), "app", "routes");
const route = (name: string) => readFileSync(join(ROUTES, name), "utf8");
/** Every route module, so a new explanatory sidebar is caught wherever it is added. */
const ALL_ROUTES = readdirSync(ROUTES).filter((f) => f.endsWith(".tsx"));

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("the note itself", () => {
  const html = render(
    <HelpNote label="What these mean">
      <s-paragraph>Baseline is the reference price.</s-paragraph>
    </HelpNote>,
  );

  it("costs the page one line and no column", () => {
    expect(html).toContain("What these mean");
    expect(html).not.toContain('slot="aside"');
  });

  it("opens an overlay, so nothing on the page moves when it is read", () => {
    // The reason this is a popover and not a disclosure. An expanding panel pushes the
    // table down at the moment the merchant is trying to read it.
    expect(html).toContain("<s-popover");
  });

  it("wires the button to that overlay, which is the only thing that opens it", () => {
    // `commandFor` is an id lookup. A mismatch renders both elements, throws nothing, and
    // leaves a button that does not work.
    const id = /<s-popover[^>]*\sid="([^"]+)"/.exec(html)?.[1];

    expect(id, "the popover has no id, so nothing can address it").toBeTruthy();
    expect(html, "the button opens some other popover, or none").toContain(
      `commandFor="${id}"`,
    );
  });

  it("carries a command, without which Polaris attaches no click handler at all", () => {
    // This shipped once with `commandFor` alone, because that is what every example on
    // Shopify's popover page shows. The button rendered, looked right, and did nothing.
    //
    // `polaris.js` builds the activator as `commandFor && command ? {...} : undefined`
    // and re-checks `command` inside the handler, so the prop the docs omit is the one
    // that makes the control exist. Polaris' own colour field passes `--toggle`.
    expect(html, "a popover activator without a command is an inert button").toMatch(
      /<s-button[^>]*\scommand="--toggle"/,
    );
  });

  it("gives the prose an interior and a measure, because s-popover supplies neither", () => {
    expect(html).toMatch(/<s-popover[^>]*>\s*<s-box[^>]*padding=/);
    expect(html).toMatch(/<s-box[^>]*inlineSize="\d+px"/);
  });

  it("sizes the box and not the overlay", () => {
    // Not a preference. `inlineSize` on the `s-popover` itself made every `s-table` in
    // the app fall back to its stacked list -- the catalogue and the plans table both,
    // on pages whose tables had not been touched, with the Polaris bundle byte-identical
    // across the two deploys. The popover shrink-wraps its content, so sizing the box
    // gets the same column without putting a definite size on the overlay.
    const popover = /<s-popover([^>]*)>/.exec(html)?.[1] ?? "";

    expect(
      popover,
      "a sized overlay breaks table layout app-wide — see docs/polaris-notes.md",
    ).not.toMatch(/inlineSize/);
  });

  it("says it is help rather than a filter or a link away", () => {
    // A merchant who does not know what "baseline" means is not scanning the page for the
    // word "what". The icon is what makes the line findable.
    expect(html).toContain('icon="question-circle"');
  });

  it("is quiet enough not to compete with the page's actual actions", () => {
    // `ActionRow`'s vocabulary: chrome is for things the page wants done, and reading a
    // definition is not one of them.
    expect(html).toContain('variant="tertiary"');
  });
});

describe("the prose each page used to keep in a column", () => {
  /**
   * The ten notes, and a phrase from each that only that explanation would contain.
   *
   * These are deliberately short and load-bearing rather than long quotations. The prose
   * gets edited — it was cut to fit a 320px popover once already — and a test that pins a
   * whole sentence fails on every rewrite, which trains people to update the phrase
   * without reading what they broke. A phrase that carries the *point* of the paragraph
   * still fails when the point goes missing.
   */
  const MOVED: Array<[route: string, title: string, phrase: string]> = [
    ["app.prices._index.tsx", "What these mean", "the reference every campaign computes from"],
    ["app.prices.baselines._index.tsx", "Reading this page", "recapture or import"],
    ["app.prices.drift.tsx", "What the three choices do", "make the new price the baseline"],
    ["app.prices.baselines.recapture.tsx", "If you get this wrong", "Baselines are append-only"],
    ["app.campaigns._index.tsx", "How campaigns resolve", "They never stack"],
    ["app.campaigns.new.tsx", "Nothing is written yet", "records the rule"],
    ["app.campaigns.import.tsx", "Only price files are listed", "do not record a file yet"],
    ["app.activity.tsx", "What is kept", "Retention is not a paid tier"],
    ["app.settings._index.tsx", "Why floors are checked last", "Rounding down can push"],
    ["app.settings.segments.tsx", "Dynamic or frozen", "re-checks its filter every time"],
  ];

  it.each(MOVED)("%s still explains itself", (name, title, phrase) => {
    const source = route(name);

    expect(source, `${name} lost the note titled "${title}"`).toContain(
      `<HelpNote label="${title}">`,
    );
    expect(source, `${name} kept the note but dropped a paragraph out of it`).toContain(phrase);
  });

  it("leaves none of them still holding a column", () => {
    const stuck = MOVED.filter(([name, title]) =>
      route(name).includes(`<s-section slot="aside" heading="${title}">`),
    );

    expect(stuck.map(([name]) => name)).toEqual([]);
  });
});

describe("what stays in the aside", () => {
  /**
   * The rule the column follows now: a sidebar carries facts about *this shop*, on the
   * one page whose job is showing several of them at once. Everything else lost its
   * column — prose became a note, and two cards that were facts filed away from their
   * subject moved next to it (cost coverage to the cost-floor settings, failures by code
   * to the failures they count).
   *
   * Checked rather than written down, because the next explanatory sidebar will be added
   * by someone who has not read `PageShell`.
   */
  const FACTS = [
    ["app._index.tsx", "Store"],
    ["app._index.tsx", "Recent activity"],
  ] as const;

  it.each(FACTS)("%s keeps its %s card beside the content", (name, heading) => {
    expect(route(name)).toContain(`<s-section slot="aside" heading="${heading}">`);
  });

  it("is the dashboard and nowhere else", () => {
    const routes = ALL_ROUTES.filter((name) => route(name).includes('slot="aside"'));

    expect(routes, "a second page with a sidebar is a rule that has started drifting").toEqual(
      ["app._index.tsx"],
    );
  });

  it("moved the two facts that were filed away from their subject", () => {
    // Both were sidebar cards. Neither was help, and neither needed a column -- they
    // needed to be next to the thing they qualify.
    expect(
      route("app.settings._index.tsx"),
      "cost coverage belongs with the cost-floor settings whose scope it describes",
    ).toMatch(/variants have a cost[\s\S]*?name="missingCostPolicy"/);

    expect(
      route("app.settings.diagnostics.tsx"),
      "the breakdown belongs above the failures it counts",
    ).toMatch(/<CountsRow items=\{byKind\}[\s\S]*?<s-table>/);
  });

  it("and nothing else does", () => {
    const asides = ALL_ROUTES.flatMap((name) => {
      const headings = [...route(name).matchAll(/<s-section slot="aside" heading="([^"]+)">/g)];
      return headings.map((match) => [name, match[1]] as const);
    });

    const unexpected = asides.filter(
      ([name, heading]) => !FACTS.some(([file, kept]) => file === name && kept === heading),
    );

    expect(
      unexpected,
      "an aside holding an explanation is a column spent on a paragraph — use HelpNote",
    ).toEqual([]);
  });
});
