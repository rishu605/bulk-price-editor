/**
 * The explanations survived being folded away.
 *
 * Ten pages had their teaching prose in an `s-section slot="aside"` — a permanent 22rem
 * column, full height, next to the table the merchant came for. Moving it into a
 * disclosure at the foot of the page has one obvious failure and one quiet one:
 *
 * - obvious: the panel never opens, so the prose is gone from the product;
 * - quiet: a paragraph is dropped during the move. Nothing errors, nothing looks wrong,
 *   and the page simply stops explaining what a baseline is. `sections.test.ts` guards
 *   the same failure for the campaign tabs, and for the same reason.
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

describe("closed, which is how a page starts", () => {
  const html = render(
    <HelpNote label="What these mean">
      <s-paragraph>Baseline is the reference price.</s-paragraph>
    </HelpNote>,
  );

  it("costs the page one line and no column", () => {
    expect(html).toContain("What these mean");
    expect(html, "the prose is the whole reason this collapses").not.toContain(
      "Baseline is the reference price.",
    );
  });

  it("says it is help rather than a filter or a link away", () => {
    // A merchant who does not know what "baseline" means is not scanning the foot of the
    // page for the word "what". The icon is what makes the line findable.
    expect(html).toContain('icon="question-circle"');
  });

  it("names the state for assistive technology, since the label does not change", () => {
    expect(html).toContain('accessibilityLabel="Show: What these mean"');
  });

  it("is quiet enough not to compete with the page's actual actions", () => {
    // `ActionRow`'s vocabulary: chrome is for things the page wants done, and reading a
    // definition is not one of them.
    expect(html).toContain('variant="tertiary"');
  });

  it("rules itself off, so it reads as the page's annotation and not the last card's", () => {
    expect(html).toContain("<s-divider");
  });
});

describe("the page it sits at the foot of", () => {
  it("does not take a column back to say so", () => {
    // The whole point. A note that reappeared as an aside would be the original bug with
    // an extra component in front of it.
    const html = render(
      <HelpNote label="How campaigns resolve">
        <s-paragraph>Exactly one wins.</s-paragraph>
      </HelpNote>,
    );

    expect(html).not.toContain('slot="aside"');
  });
});

describe("the prose each page used to keep in a column", () => {
  /** The ten notes, and a phrase from each that only that explanation would contain. */
  const MOVED: Array<[route: string, title: string, phrase: string]> = [
    ["app.prices._index.tsx", "What these mean", "reference price every campaign computes"],
    ["app.prices.baselines._index.tsx", "Reading this page", "rather than against a previous discount"],
    ["app.prices.drift.tsx", "What the three choices do", "makes the new price the baseline"],
    ["app.prices.baselines.recapture.tsx", "If you get this wrong", "Baselines are append-only"],
    ["app.campaigns._index.tsx", "How campaigns resolve", "They never stack"],
    ["app.campaigns.new.tsx", "Nothing is written yet", "only records the rule"],
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
   * The rule the column now follows: an aside carries facts about *this shop*, which
   * change per merchant and per visit and are therefore worth a permanent column. Prose
   * about how the app works does not change, so it is a note.
   *
   * Checked rather than written down, because the next explanatory sidebar will be added
   * by someone who has not read `PageShell`.
   */
  const FACTS = [
    ["app._index.tsx", "Store"],
    ["app._index.tsx", "Recent activity"],
    ["app.settings._index.tsx", "Cost data"],
    ["app.settings.diagnostics.tsx", "By kind"],
  ] as const;

  it.each(FACTS)("%s keeps its %s card beside the content", (name, heading) => {
    expect(route(name)).toContain(`<s-section slot="aside" heading="${heading}">`);
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
