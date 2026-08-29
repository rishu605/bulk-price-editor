import { formatCount } from "../lib/format/display";
import { Blank } from "./Blank";
import { ActionRow } from "./ActionRow";
import { EmptyState } from "./AsyncState";
import { exampleRowFrom, StorefrontExample } from "./StorefrontExample";
import { OverlapPanel } from "./OverlapPanel";
import { SPACE } from "../lib/ui/spacing";
import type { DraftPreview as Preview } from "../services/campaigns/draft-preview.server";

/**
 * What this rule would do to prices, before the campaign exists.
 *
 * The editor could previously only say how many variants matched. To find out what
 * happened to a price you had to create the campaign — so the only way to learn what a
 * rule did was to commit to it.
 *
 * The claim being made here is stronger than a competitor's identical-looking panel:
 * `resolve()` runs in preview and execution alike, against baselines rather than live
 * prices, so these are the prices that will be written and not an estimate of them.
 * Which is exactly why the counts have to be honest about the rows that will *not* be
 * written — a preview that showed only the happy rows would be the estimate it claims
 * not to be.
 */
export function DraftPreview({
  preview,
  pending = false,
  surface,
  fullPreviewHref,
}: {
  preview: Preview | null;
  /**
   * Where "see all rows" goes, with this draft serialised into it.
   *
   * Built by the editor rather than here, because it is the editor that holds the form
   * this panel is describing — and a component that reached into the DOM for a form it
   * does not own would be one that only works on the one page it was written for.
   */
  fullPreviewHref?: string;
  /** A request is in flight. See the note on the first branch below. */
  pending?: boolean;
  /**
   * Which price the panel is showing, when the shop has more than one.
   *
   * `previewDraft` prices the base surface. On a single-market shop that needs no
   * saying; on a shop with catalogues it very much does, because the merchant is looking
   * at a card headed "on your storefront" and has three storefronts.
   */
  surface?: string;
}) {
  if (!preview) {
    return (
      <s-paragraph>
        <s-text color="subdued">
          {/* "Set a rule" is wrong while one is being priced — and on first load a rule
              is already set, so it would be wrong immediately. The panel used to be
              primed by the loader, which is what made that sentence unreachable; asking
              from the client instead (#468) makes this the first thing a merchant reads,
              for about a second. */}
          {pending ? "Working out what this would do…" : "Set a rule to see what it would do."}
        </s-text>
      </s-paragraph>
    );
  }

  if (preview.blocked) {
    return (
      <s-banner tone="critical">
        <s-paragraph>
          This rule would price {preview.blocked.variantGid.split("/").pop()} below your
          floor, and your guardrail setting is to stop rather than adjust. Nothing would
          be written. Lower the floor, narrow the scope, or change the rule.
        </s-paragraph>
      </s-banner>
    );
  }

  if (preview.matched === 0) {
    return (
      // `EmptyState` rather than `NoMatches`, deliberately. `NoMatches` cannot be
      // called without saying where Clear filters goes, and after #442 the scope is
      // form state rather than a query string: there is no URL that clears it, and a
      // link that navigated would discard the rule the merchant has just typed. The
      // way out is the selects a few inches to the left, so the sentence points at
      // them instead of a button pointing at nothing.
      <EmptyState
        title="Nothing matches this scope"
        description="No variant matches every condition. Loosen one, or leave them all blank to target the whole catalogue."
      />
    );
  }

  const example = exampleRowFrom(preview.rows);

  return (
    <s-stack gap={SPACE.section}>
      {/* Above the counts, because it answers a question asked before them: a merchant
          who has typed a percentage wants to know what it looks like, and only then how
          many products it reaches. */}
      {example ? <StorefrontExample row={example} surface={surface} /> : null}

      {/* Above the counts, because it changes what they mean: "3,669 of 3,669 would
          change" reads differently once a merchant knows 1,240 of them belong to
          something else. */}
      <OverlapPanel overlaps={preview.overlaps} />

      <s-paragraph>
        <s-text>
          <strong>{formatCount(preview.changing)}</strong> of {formatCount(preview.matched)}{" "}
          variants would change price.
        </s-text>
        {/* The previous answer stays while a new one is computed, marked as stale rather
            than replaced by a placeholder. Blanking the panel on every keystroke would
            make the numbers flicker and give a merchant nothing to compare against. */}
        {pending ? (
          <s-text color="subdued"> · updating…</s-text>
        ) : null}
      </s-paragraph>

      {/* Every row that will not move, and why. A merchant who expected 400 and sees 380
          needs the other 20 explained here rather than after the run. */}
      {preview.alreadyCorrect > 0 ? (
        <s-paragraph>
          <s-text color="subdued">
            {formatCount(preview.alreadyCorrect)} already at this price.
          </s-text>
        </s-paragraph>
      ) : null}
      {preview.skipped > 0 ? (
        <s-paragraph>
          <s-text tone="caution">
            {formatCount(preview.skipped)} would be left alone — see the reasons below.
          </s-text>
        </s-paragraph>
      ) : null}
      {preview.withoutBaseline > 0 ? (
        <s-paragraph>
          <s-text tone="caution">
            {formatCount(preview.withoutBaseline)} have no baseline yet, so they cannot be
            priced at all. Sync your catalogue to capture them.
          </s-text>
        </s-paragraph>
      ) : null}

      {/* Said once, above the table, rather than on every row that has one.
          
          A `live` figure means the storefront is not at the baseline, and there are two
          reasons for that: another campaign is pricing the variant, or somebody changed
          it outside the app. Claiming which on a row would be a guess — the resolver
          gave this row to *this* draft, so it does not know who priced it last — and
          `Prices → Drift` is where the app already answers the question properly.
          
          Absent when no row has drifted, which is the ordinary case. */}
      {preview.rows.some((row) => row.live) ? (
        <s-stack gap={SPACE.tight}>
          <s-paragraph>
            <s-text color="subdued">
              Some of these show a <s-text type="strong">live</s-text> price that is not
              their baseline: either another campaign is pricing them, or the storefront
              was changed outside this app.
            </s-text>
          </s-paragraph>
          {/* A tertiary button, not a link. `ActionRow`'s vocabulary reserves blue text
              for a word *inside* a sentence where colour is doing necessary work; this
              is a standalone way out of the card, which is what tertiary is for. */}
          <ActionRow>
            <s-button variant="tertiary" href="/app/prices/drift">
              Review drifted prices
            </s-button>
          </ActionRow>
        </s-stack>
      ) : null}

      {preview.rows.length > 0 ? (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Variant</s-table-header>
            {/* "Baseline", not "Now".

                The two are different numbers and the difference is the product. Every
                competitor computes a relative change against whatever the storefront
                says right now, which is why RUBIX's own FAQ has to explain that a 30%
                sale followed by a 50% sale leaves a product at 35% of its original price
                for ever. Calling this column "Now" would describe their arithmetic
                rather than ours. */}
            <s-table-header listSlot="inline" format="currency">Baseline</s-table-header>
            {/* Inline, both of them: collapsed, the row reads "Cotton tee - $24.00
                $19.20", which is the whole question this panel answers. Labelled pairs
                would put the two halves of a before-and-after on separate lines. */}
            <s-table-header listSlot="inline" format="currency">Would become</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {preview.rows.map((row) => (
              <s-table-row key={row.variantGid}>
                <s-table-cell>
                  {/* The picture and the name are one thing, so they sit on one line at
                      tight rhythm. A variant with no image still gets a row -- a product
                      without a photo is ordinary, and a broken frame would read as an
                      error the merchant needs to fix. */}
                  <s-stack direction="inline" gap={SPACE.tight} alignItems="center">
                    {row.imageUrl ? (
                      <s-thumbnail src={row.imageUrl} alt="" size="small" />
                    ) : null}
                    <s-text>{row.title}</s-text>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>
                  {row.before ?? <Blank />}
                  {row.beforeCompareAt ? ` (was ${row.beforeCompareAt})` : ""}
                  {/* Only when the storefront disagrees with the baseline, which means
                      the variant is mid-campaign or has drifted. Silence is the ordinary
                      case; a merchant reading "40.00 becomes 32.00" beside a storefront
                      showing 28.00 needs to be told which number we are working from. */}
                  {row.live ? (
                    <s-paragraph>
                      <s-text tone="caution">live {row.live}</s-text>
                    </s-paragraph>
                  ) : null}
                </s-table-cell>
                <s-table-cell>
                  {row.skippedReason ? (
                    <s-text tone="caution">{row.skippedReason}</s-text>
                  ) : row.unchanged ? (
                    <s-text color="subdued">no change</s-text>
                  ) : (
                    <s-text>
                      {row.after ?? <Blank />}
                      {row.afterCompareAt ? ` (was ${row.afterCompareAt})` : ""}
                    </s-text>
                  )}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      ) : null}

      {preview.changing + preview.alreadyCorrect + preview.skipped > preview.rows.length ? (
        <s-stack gap={SPACE.tight}>
          <s-text color="subdued">
            Showing the first {formatCount(preview.rows.length)}. Every row is priced the
            same way.
          </s-text>
          {/* The escape hatch. "Showing the first 25" is a promise a merchant has to take
              on trust, on the one screen whose whole job is not asking them to — and the
              panel cannot be the list, because it lives beside the form. NA has the same
              button under its inline preview. */}
          {fullPreviewHref ? (
            <ActionRow>
              <s-button variant="tertiary" href={fullPreviewHref}>
                See all {formatCount(preview.changing + preview.alreadyCorrect + preview.skipped)} rows
              </s-button>
            </ActionRow>
          ) : null}
        </s-stack>
      ) : null}
    </s-stack>
  );
}
