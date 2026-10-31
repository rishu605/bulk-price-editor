/**
 * The Ledger tab's "Revert this variant", rendered (#764).
 *
 * On a campaign applied and then reverted, the tab showed the newest run -- the revert --
 * with the button on every row. Pressing one wrote nothing visible and took the variant
 * out of the campaign for good, so the next apply skipped it without a word. Nothing said
 * which run the table was, so the revert's "Before 0.28, Intended 0.40" read as a rise;
 * and the button posted straight through, the one price write in the app with no dialog.
 *
 * Rendered rather than grepped: the assertions are about which rows of which run, in
 * which campaign state, carry a control -- a matrix only a render can walk.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { formatWhen } from "../../lib/format/display";
import { ALL_STATES, type CampaignState } from "../../lib/lifecycle/transitions";
import { CampaignLedgerTab, revertTarget } from "./CampaignLedgerTab";
import { VARIANT_REVERT_MODAL_ID, VariantRevertConfirmation } from "./VariantRevertConfirmation";
import type { CampaignDetailProps } from "./props";

const FINISHED = "2026-10-14T09:32:00.000Z";

const row = (variantGid: string, title: string, status = "VERIFIED") => ({
  variantGid,
  title,
  before: "$100.00",
  intended: "$80.00",
  status,
  failureReason: null,
});

const APPLY = { id: "run_apply", kind: "APPLY", startedAt: FINISHED, finishedAt: FINISHED, createdAt: FINISHED };
const REVERT = { id: "run_revert", kind: "REVERT", startedAt: FINISHED, finishedAt: FINISHED, createdAt: FINISHED };

const props = (over: Record<string, unknown> = {}) =>
  ({
    preview: { name: "Autumn sale", markets: [] },
    ledger: [row("gid://shopify/ProductVariant/1", "Alpine Snowboard · XS"), row("gid://shopify/ProductVariant/2", "Alpine Snowboard · S")],
    ledgerTotal: 2,
    ledgerRun: APPLY,
    selectedRunId: APPLY.id,
    state: "ACTIVE",
    rollback: null,
    excludedVariantGids: [],
    timeZone: "UTC",
    fetcher: { Form: "form", state: "idle", submit: () => undefined },
    busy: false,
    ...over,
  }) as unknown as CampaignDetailProps;

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<StaticRouter location="/app/campaigns/c1?tab=ledger">{node}</StaticRouter>);

/** Everything before the dialog: the card and its table. */
const table = (html: string) => html.split("<s-modal")[0];
const buttons = (html: string) => (table(html).match(/>Revert this variant</g) ?? []).length;

describe("Revert this variant is offered only where it can do what it says", () => {
  it("is on every row an apply of a running campaign wrote", () => {
    expect(buttons(render(<CampaignLedgerTab {...props()} />))).toBe(2);
  });

  it("is on no row of a revert -- the live case, a campaign applied and then reverted", () => {
    const html = render(<CampaignLedgerTab {...props({ state: "COMPLETED", ledgerRun: REVERT, selectedRunId: REVERT.id })} />);

    expect(html, "a revert's rows still offer to revert them").not.toContain("Revert this variant");
    expect(html, "an Action column with nothing in it").not.toContain(">Action<");
    expect(html, "a dialog for a button that is not there").not.toContain("<s-modal");
  });

  it("is on no row of a revert while the campaign still runs, after one variant was reverted", () => {
    // The scoped revert becomes the newest run, so it is the ledger the tab opens on.
    const html = render(<CampaignLedgerTab {...props({ ledgerRun: REVERT, selectedRunId: REVERT.id })} />);
    expect(buttons(html)).toBe(0);
  });

  const live = new Set<CampaignState>(["ACTIVE", "HELD", "PARTIAL"]);
  it.each(ALL_STATES)("on an apply's ledger of a %s campaign: offered only if it is live", (state) => {
    // Draft and scheduled have no prices up; Completed and Cancelled have put them back;
    // Applying and Reverting are being written by another run right now.
    expect(buttons(render(<CampaignLedgerTab {...props({ state })} />)) > 0).toBe(live.has(state));
  });

  it("is not on a row that never landed", () => {
    const html = render(
      <CampaignLedgerTab
        {...props({
          ledger: [
            row("gid://shopify/ProductVariant/1", "Failed one", "FAILED"),
            row("gid://shopify/ProductVariant/2", "Skipped one", "SKIPPED"),
            row("gid://shopify/ProductVariant/3", "Clamped one", "CLAMPED"),
            row("gid://shopify/ProductVariant/4", "Sent one", "APPLIED"),
          ],
        })}
      />,
    );
    expect(buttons(html), "clamped and sent-to-Shopify rows were written; failed and skipped were not").toBe(2);
  });

  it("is once per variant, not once per surface the variant was written on", () => {
    // Base, then two markets: three rows for one variant, and one revert of all three.
    const gid = "gid://shopify/ProductVariant/1";
    const html = render(
      <CampaignLedgerTab {...props({ ledger: [row(gid, "Alpine · XS"), row(gid, "Alpine · XS"), row(gid, "Alpine · XS")] })} />,
    );
    expect(buttons(html)).toBe(1);
  });
});

describe("the button asks first", () => {
  const html = render(<CampaignLedgerTab {...props()} />);

  it("opens the confirmation rather than posting", () => {
    expect(table(html)).toContain(`commandFor="${VARIANT_REVERT_MODAL_ID}"`);
    // `polaris.js` builds the click handler only when both are present.
    expect(table(html)).toContain('command="--show"');
    expect(table(html), "the row posts straight through again").not.toContain('value="revert-variant"');
    expect(table(html)).not.toContain("<form");
  });

  it("draws the dialog once, outside the card, with a submit Polaris will render", () => {
    expect(html.split("<s-modal").length - 1).toBe(1);
    expect(html.indexOf("</s-section>")).toBeLessThan(html.indexOf("<s-modal"));
    const dialog = html.slice(html.indexOf("<s-modal"));
    expect(dialog).toMatch(/<s-button[^>]*slot="primary-action"[^>]*variant="primary"/);
    expect(dialog, "a form in a modal is what swallowed the submit in #609").not.toContain("<form");
  });

  it("keeps the card's own buttons quiet", () => {
    expect(table(html)).not.toContain('variant="primary"');
  });
});

describe("the confirmation names the variant, its price, and that leaving is for good", () => {
  const target = {
    variantGid: "gid://shopify/ProductVariant/1",
    title: "Alpine Snowboard · XS",
    revertsTo: "$90.00",
    excluded: false,
  };

  it("names the variant and the price resolution puts it at", () => {
    const html = render(
      <VariantRevertConfirmation campaignName="Autumn sale" target={target} marketNames={[]} onConfirm={() => undefined} />,
    );

    expect(html).toContain("Revert Alpine Snowboard · XS?");
    expect(html).toContain("$90.00");
    // Recomputed, not restored: it can land on another sale's price.
    expect(html).toContain("worked out again");
  });

  it("says the variant leaves the campaign for good, later runs included", () => {
    const html = render(
      <VariantRevertConfirmation campaignName="Autumn sale" target={target} marketNames={[]} onConfirm={() => undefined} />,
    );
    expect(html).toContain("leaves Autumn sale for good");
    expect(html).toMatch(/scheduled, or\s+applying the campaign again/);
  });

  it("names the markets whose prices move with it", () => {
    const html = render(
      <VariantRevertConfirmation
        campaignName="Autumn sale"
        target={target}
        marketNames={["Europe", "Wholesale"]}
        onConfirm={() => undefined}
      />,
    );
    expect(html).toContain("Its prices in Europe and Wholesale are worked out the same way.");
  });

  it("does not invent a price it does not have", () => {
    const html = render(
      <VariantRevertConfirmation
        campaignName="Autumn sale"
        target={{ ...target, revertsTo: null }}
        marketNames={[]}
        onConfirm={() => undefined}
      />,
    );
    expect(html).not.toContain("Its price goes to");
    expect(html).toContain("worked out again without Autumn sale");
  });

  it("tells a second press it only rewrites a variant already let go of", () => {
    const html = render(
      <VariantRevertConfirmation
        campaignName="Autumn sale"
        target={{ ...target, excluded: true, revertsTo: null }}
        marketNames={[]}
        onConfirm={() => undefined}
      />,
    );
    expect(html).toContain("already out of Autumn sale");
    expect(html).not.toContain("for good");
  });

});

describe("what a pressed row tells the confirmation", () => {
  // Pressing is client-side state, which a server render cannot click; this is the hand-over
  // the button's onClick makes.
  const rollback = {
    rows: [
      { variantGid: "gid://shopify/ProductVariant/1", revertsTo: "$90.00" },
      { variantGid: "gid://shopify/ProductVariant/2", revertsTo: "$45.00" },
    ],
  };

  it("takes the price from the rollback report, which plans with the revert's own planner", () => {
    expect(revertTarget({ variantGid: "gid://shopify/ProductVariant/2", title: "S" }, rollback, [])).toEqual({
      variantGid: "gid://shopify/ProductVariant/2",
      title: "S",
      revertsTo: "$45.00",
      excluded: false,
    });
  });

  it("has no price for a variant the report does not cover, rather than a guess", () => {
    expect(revertTarget({ variantGid: "gid://shopify/ProductVariant/9", title: "X" }, rollback, []).revertsTo).toBeNull();
    expect(revertTarget({ variantGid: "gid://shopify/ProductVariant/1", title: "XS" }, null, []).revertsTo).toBeNull();
  });

  it("knows a variant already let go of", () => {
    const gid = "gid://shopify/ProductVariant/1";
    expect(revertTarget({ variantGid: gid, title: "XS" }, rollback, [gid]).excluded).toBe(true);
  });
});

describe("the ledger says which run it is", () => {
  it("names an apply and when it finished", () => {
    const html = render(<CampaignLedgerTab {...props()} />);
    expect(html).toContain(`The apply that finished ${formatWhen(FINISHED, "UTC")}`);
    expect(html).toContain(">Intended<");
  });

  it("names a revert, and heads its second price as where it went back to", () => {
    const html = render(<CampaignLedgerTab {...props({ state: "COMPLETED", ledgerRun: REVERT, selectedRunId: REVERT.id })} />);
    expect(html).toContain(`The revert that finished ${formatWhen(FINISHED, "UTC")}`);
    expect(html).toContain(">Reverts to<");
    expect(html, "a revert's rows headed as if they were a sale's").not.toContain(">Intended<");
  });

  it("says a run still writing has only started", () => {
    const html = render(<CampaignLedgerTab {...props({ ledgerRun: { ...APPLY, finishedAt: null } })} />);
    expect(html).toContain(`The apply that started ${formatWhen(FINISHED, "UTC")}`);
  });
});
