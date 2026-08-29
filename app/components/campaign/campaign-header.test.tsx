/**
 * The campaign page's header, and the shape of its tab bodies.
 *
 * The page opened with two cards above the tab bar — one holding a status badge, one
 * titled "Actions" holding a column of buttons — which is the almost-empty rectangle the
 * campaigns index stopped drawing in #395. Then, inside the Preview tab, it put cards
 * inside cards three deep.
 *
 * Rendered rather than grepped wherever the assertion is about what a merchant sees:
 * these are components with props, so the states that matter (draft, partial, drifted,
 * practice) can each be rendered and looked at. The nesting rule is the one exception —
 * it is a property of the whole app, so it is checked over the source of every file.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { CampaignHeader } from "./CampaignHeader";
import { CampaignOverviewTab } from "./CampaignOverviewTab";
import { describeState } from "../../lib/lifecycle/transitions";
import { describeCampaign } from "../../lib/campaigns/describe";
import { formatWhen } from "../../lib/format/display";
import type { CampaignDetailProps } from "./props";

/**
 * The loader's shape, as far as the header reads it.
 *
 * `describeState` rather than a hand-written lifecycle: a fixture that invents its own
 * shape stops catching the day the real one grows a field.
 */
/** A campaign the confirmation can describe: small, base-only, nothing clamped. */
const preview = (over: Record<string, unknown> = {}) => ({
  campaignId: "c1",
  name: "Autumn sale",
  status: "DRAFT",
  counts: { planned: 40, noop: 2, skipped: 1, clamped: 0 },
  rows: [],
  writePath: "sync",
  writePathReason: "under the threshold",
  markets: [],
  margin: null,
  blastRadius: false,
  ...over,
});

const props = (over: Partial<CampaignDetailProps> = {}) =>
  ({
    lifecycle: describeState("DRAFT"),
    preview: preview(),
    scheduleText: "Starts 1 Sep 2026, 09:00",
    practice: false,
    canApply: true,
    busy: false,
    rollback: null,
    history: [],
    timeZone: "Europe/London",
    warnings: [],
    autoEnroll: false,
    enrollPendingAt: null,
    fetcher: { Form: "form", state: "idle" },
    // Through the real formatter, so this fixture cannot describe a campaign in words
    // the campaigns index would never produce.
    ...describeCampaign({
      rule: { kind: "percent-change", percent: -20 },
      ast: { groups: [{ conditions: [{ field: "collection", value: "Outerwear" }] }] },
    }),
    keepers: null,
    keepersPending: false,
    ...over,
  }) as unknown as CampaignDetailProps;

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<StaticRouter location="/app/campaigns/c1">{node}</StaticRouter>);

describe("status and the next action are one row, not two cards", () => {
  const html = render(<CampaignHeader {...props()} />);

  it("draws no card of its own", () => {
    expect(html).not.toContain("<s-section");
  });

  it("keeps the status and the actions on one line", () => {
    // `1fr auto`: the status takes the space, the actions take what they need. A block
    // stack — which is what the old card had — puts every button on its own line.
    expect(html).toMatch(/gridtemplatecolumns="1fr auto"/i);
  });

  it("shows the lifecycle badge and the schedule beside it", () => {
    expect(html).toContain("Draft");
    expect(html).toContain("Starts 1 Sep 2026, 09:00");
  });
});

describe("at most one action is black", () => {
  /**
   * Black buttons **on the header row**, which is what the rule is about.
   *
   * The confirmation modal's own primary action does not count: a modal is closed until
   * it is opened, and when it is open it is the only thing on screen. The rule exists
   * because two black buttons side by side — one of them disabled — is the loudest
   * possible way to offer something that cannot be done, and a button in a closed
   * overlay is not side by side with anything.
   *
   * So the modal is cut off the end before counting, rather than the rule being relaxed.
   */
  const primaries = (html: string) => {
    const row = html.split("<s-modal")[0];
    return (row.match(/variant="primary"/g) ?? []).length;
  };

  it("offers Apply as the primary on a draft that can be applied", () => {
    const html = render(<CampaignHeader {...props()} />);

    expect(html).toContain("Apply to storefront");
    expect(primaries(html)).toBe(1);
  });

  it("hands the primary to Resume on a partial run, and only to Resume", () => {
    // Both were primary at once in the old card, one of them disabled — the loudest
    // possible way to offer something that cannot be done.
    const html = render(
      <CampaignHeader {...props({ lifecycle: describeState("PARTIAL"), canApply: false })} />,
    );

    expect(html).toContain("Resume");
    expect(primaries(html)).toBe(1);
  });

  it("offers nothing black when nothing can be done", () => {
    const html = render(
      <CampaignHeader {...props({ lifecycle: describeState("COMPLETED"), canApply: false })} />,
    );

    expect(primaries(html)).toBe(0);
  });
});

describe("a practice campaign is never offered a way to apply", () => {
  const html = render(<CampaignHeader {...props({ practice: true })} />);

  it("does not render the apply button at all", () => {
    // Not merely disabled: offering a control that exists only to be refused undermines
    // the promise the merchant was given when they chose practice.
    expect(html).not.toContain("Apply to storefront");
  });
});

describe("a revert with edits to decide about points at the decision", () => {
  const drifted = {
    straightforward: false,
    counts: { total: 40, drifted: 3, deleted: 0 },
    rows: [],
  };

  const html = render(<CampaignHeader {...props({ rollback: drifted as never })} />);

  it("links to the revert tab instead of offering a one-click revert", () => {
    expect(html).toContain('href="?tab=revert"');
    expect(html).toContain("3");
  });

  it("no longer says the report is above, which it has not been since it became a tab", () => {
    expect(html).not.toContain("above");
  });

  it("still offers a plain revert when there is nothing to decide", () => {
    const clean = render(
      <CampaignHeader
        {...props({
          rollback: { straightforward: true, counts: { total: 40, drifted: 0, deleted: 0 }, rows: [] } as never,
        })}
      />,
    );

    expect(clean).toContain("Revert");
    expect(clean).not.toContain('href="?tab=revert"');
  });
});

describe("the transition history is readable by the person reading it", () => {
  const html = render(
    <CampaignOverviewTab
      {...props({
        history: [
          {
            at: "2026-08-20T09:30:00.000Z",
            from: "DRAFT",
            to: "ACTIVE",
            reason: "Applied by hand",
            actor: "system",
          },
          // The first transition has no previous status, so `from` is an em dash — which
          // `describeState` has no case for and would throw on.
          { at: "2026-08-19T08:00:00.000Z", from: "—", to: "DRAFT", reason: "", actor: "system" },
        ],
      })}
    />,
  );

  it("names the states the way the rest of the app names them", () => {
    expect(html).toContain("Draft");
    expect(html).toContain("Active");
    expect(html).not.toContain("DRAFT");
    expect(html).not.toContain("ACTIVE");
  });

  it("renders the timestamp that was being loaded and thrown away", () => {
    // The exact string the shared formatter produces for the shop's zone, not just "the
    // year appears somewhere" — the schedule sentence two sections down also carries a
    // year, and the first version of this assertion passed with the column removed.
    expect(html).toContain(formatWhen("2026-08-20T09:30:00.000Z", "Europe/London"));
  });

  it("names the actor the way the activity log does", () => {
    expect(html).toContain("Scheduler");
    expect(html).not.toContain(">system<");
  });

  it("survives the transition that has no previous state", () => {
    expect(html).toContain("—");
  });
});

const APP = join(process.cwd(), "app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

describe("no card is drawn inside another card", () => {
  const offenders = tsxFiles(APP).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    let depth = 0;
    let deepest = 0;

    for (const [tag] of source.matchAll(/<s-section\b|<\/s-section>/g)) {
      depth += tag.startsWith("</") ? -1 : 1;
      deepest = Math.max(deepest, depth);
    }

    return deepest > 1 ? [`${path.replace(`${APP}/`, "")}: ${deepest} deep`] : [];
  });

  it("finds none", () => {
    expect(
      offenders,
      "an s-section is a card; a card inside a card inside the page is three borders deep, and spacing.ts says a named block that does not deserve a card gets a bare s-heading",
    ).toEqual([]);
  });
});

/**
 * The confirmation between the button and the write.
 *
 * Two of the three competitors have no confirmation at all — RUBIX has no submit button
 * in its form, and Sami changes every price in a catalogue on one click of Save. Our
 * draft-then-apply shape was already safer than both; what was missing was the sentence
 * saying what is about to happen.
 *
 * The assertions that matter are about *restraint*: a confirmation that always asks the
 * same thing is one nobody reads, so lines that do not apply must be absent rather than
 * empty, and the typed confirmation must appear only when it is earned.
 */
describe("what the apply button does now", () => {
  it("opens the confirmation rather than posting", () => {
    const html = render(<CampaignHeader {...props()} />);
    // The header row only. `commandFor` also appears on the modal's own Cancel button,
    // so searching the whole document passes even when the apply button opens nothing.
    const row = html.split("<s-modal")[0];

    expect(row).toContain('commandFor="apply-confirmation"');
    expect(row).toContain("Apply to storefront");
    // Revert legitimately posts from the row; apply must not.
    expect(row, "the apply button posts directly again").not.toContain('value="apply"');
    expect(html).toContain("<s-modal");
  });

  it("still refuses when the campaign cannot be applied", () => {
    // Opening a modal to be told no is worse than a button that says so.
    const html = render(<CampaignHeader {...props({ canApply: false })} />);

    expect(html).toContain("disabled");
  });

  it("offers nothing at all on a practice campaign", () => {
    const html = render(<CampaignHeader {...props({ practice: true })} />);

    expect(html).not.toContain("Apply to storefront");
    expect(html, "a practice campaign has no apply to confirm").not.toContain("<s-modal");
  });
});

describe("the confirmation says what is about to happen", () => {
  it("counts the prices it would write against the scope", () => {
    const html = render(<CampaignHeader {...props()} />);

    expect(html).toContain("40");
    expect(html).toContain("43 variants in scope");
  });

  it("names the markets when there are any", () => {
    const html = render(
      <CampaignHeader
        {...props({ preview: preview({ markets: [{ name: "Europe" }, { name: "Japan" }] }) })}
      />,
    );

    expect(html).toContain("Europe, Japan");
  });

  it("says nothing about markets on a base-only campaign", () => {
    // Absent, not "Markets: none" — a row to read and dismiss on every single apply.
    expect(render(<CampaignHeader {...props()} />)).not.toContain("Also priced in");
  });

  it("calls out rows raised to a guardrail floor, which the rule did not ask for", () => {
    const html = render(
      <CampaignHeader {...props({ preview: preview({ counts: { planned: 40, noop: 0, skipped: 0, clamped: 3 } }) })} />,
    );

    expect(html).toContain("Raised to a floor");
  });

  it("does not mention clamping when nothing clamps", () => {
    expect(render(<CampaignHeader {...props()} />)).not.toContain("Raised to a floor");
  });

  it("makes the baseline claim where the decision is being made", () => {
    const html = render(<CampaignHeader {...props()} />);

    expect(html).toContain("computed from its baseline");
    expect(html).toContain("recomputes without this campaign");
  });
});

describe("the typed confirmation appears only when it is earned", () => {
  it("asks for it over the blast-radius threshold", () => {
    const html = render(
      <CampaignHeader {...props({ preview: preview({ blastRadius: true, counts: { planned: 5000, noop: 0, skipped: 0, clamped: 0 } }) })} />,
    );

    expect(html).toContain("Type apply to confirm");
    expect(html).toContain('name="confirmation"');
  });

  it("does not ask on an ordinary campaign", () => {
    // A-3.11 asks for this over a thousand variants. Asking every time is how a
    // confirmation becomes a reflex.
    expect(render(<CampaignHeader {...props()} />)).not.toContain('name="confirmation"');
  });
});

/**
 * The confirmation between Revert and the write.
 *
 * The Revert *tab* already explains the recompute, and a merchant who opens it is not the
 * one at risk. The header button is: it is pressed by somebody who has decided to end a
 * sale and is not expecting a lesson, and it posted straight through — the same shape as
 * `blastRadius`, which lived only inside the Preview tab for as long as it existed.
 *
 * Reverting is the one operation in this app whose behaviour differs from every
 * competitor's. All three restore a saved price; ours recomputes. A merchant carrying the
 * wrong model presses this expecting prices to snap back to full, and the two answers
 * differ precisely when another campaign is still running — which is when it matters.
 */
const withRollback = (over: Record<string, unknown> = {}) =>
  props({
    rollback: {
      campaignId: "c1",
      campaignName: "Summer sale",
      rows: [],
      counts: { total: 812, clean: 812, drifted: 0, deleted: 0 },
      straightforward: true,
      ...over,
    },
  } as unknown as Partial<CampaignDetailProps>);

describe("what the revert button does now", () => {
  it("opens the confirmation rather than posting", () => {
    const html = render(<CampaignHeader {...withRollback()} />);
    const row = html.split("<s-modal")[0];

    expect(row).toContain('commandFor="revert-confirmation"');
    expect(row, "the revert button posts directly again").not.toContain('value="revert"');
  });

  it("still sends drifted campaigns to the tab instead of offering a one-click revert", () => {
    // There are edits to decide about; a confirmation that skipped them would be a
    // one-click overwrite wearing a seatbelt.
    const html = render(
      <CampaignHeader {...withRollback({ straightforward: false, counts: { total: 812, clean: 800, drifted: 12, deleted: 0 } })} />,
    );

    expect(html).toContain("Review 12 edited before reverting");
    expect(html).not.toContain('commandFor="revert-confirmation"');
  });
});

describe("the revert confirmation says what recomputing means", () => {
  it("leads with the thing a merchant is most likely to have wrong", () => {
    const html = render(<CampaignHeader {...withRollback()} />);

    expect(html).toContain("does not put the old prices back");
    expect(html).toContain("with this campaign removed");
  });

  it("counts what this campaign is holding", () => {
    expect(render(<CampaignHeader {...withRollback()} />)).toContain("812");
  });

  it("names the campaigns that keep some of them", () => {
    const html = render(
      <CampaignHeader
        {...withRollback()}
        keepers={{ repriced: 812, keepers: [{ campaignId: "c_clear", name: "Clearance", variants: 40 }] }}
      />,
    );

    expect(html).toContain("Not everything goes back to its baseline");
    expect(html).toContain("Clearance still covers 40 variants");
  });

  it("says so plainly when nothing else covers them", () => {
    const html = render(
      <CampaignHeader {...withRollback()} keepers={{ repriced: 812, keepers: [] }} />,
    );

    expect(html).toContain("every one of them returns to its baseline");
  });

  it("says it is working while the answer is on its way", () => {
    const html = render(<CampaignHeader {...withRollback()} keepersPending />);

    expect(html).toContain("Working out what the prices would become");
  });
});

describe("the confirmation and the index describe a campaign the same way", () => {
  it("shows the rule and the scope, in the index's own words", () => {
    // Not "the same words as the index" by coincidence: both call `describeCampaign`,
    // and `campaign-describe-shared.test.ts` refuses a second formatter.
    const html = render(<CampaignHeader {...props()} />);

    expect(html).toContain("20% off");
    expect(html).toContain("In Outerwear");
  });
});
