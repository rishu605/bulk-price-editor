import { catalogueNotice } from "../lib/catalogue/state";
import { countOf, formatCount } from "../lib/format/display";
import { LiveStatus } from "./LiveStatus";
import { MoneyCell } from "./MoneyCell";
import { ActionRow } from "./ActionRow";
import { EmptyState } from "./AsyncState";
import { exampleRowFrom, StorefrontExample } from "./StorefrontExample";
import { OverlapPanel } from "./OverlapPanel";
import { SPACE } from "../lib/ui/spacing";
import type { DraftPreview as Preview } from "../services/campaigns/draft-preview.server";
import { Secondary } from "./Type";

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
export function DraftPreview(props: DraftPreviewProps) {
  return (
    <>
      {/* First, and outside every branch below (#798). The panel swaps between a banner, an
          empty state and a table as the merchant types; a region inside any one of them
          would be a new region each time it swapped, and a new region says nothing. This
          one is on the page from the first render, empty until there is an answer. */}
      <LiveStatus message={previewAnnouncement(props.preview, props.pending ?? false)} />
      <PreviewBody {...props} />
    </>
  );
}

/**
 * What the panel says aloud when it settles, in a sentence or three (#798).
 *
 * The count line used to be the only feedback a rule change produced, and it was plain
 * text at the end of the aside — after the whole form in reading order, and not a live
 * region — so a merchant using a screen reader changed the rule and heard nothing back.
 *
 * Empty while a request is in flight, which the visible panel is not: it keeps the old
 * figures marked "updating…" so there is something to compare against. A region whose
 * text goes from X to X has not changed, so clearing it is what makes an identical answer
 * to a changed rule audible as an answer.
 *
 * The example product is said as well as the counts, because 20% off and 30% off reach
 * the same "3 of 5" — the example is the part that moves.
 */
export function previewAnnouncement(preview: Preview | null, pending: boolean): string {
  if (pending || !preview) return "";
  if (preview.ruleProblem) return preview.ruleProblem;
  // The banner's own sentence, which names each variant, its price and its floor (#1076).
  if (preview.blocked) return preview.blocked.message;

  const notice = preview.catalogue ? catalogueNotice(preview.catalogue) : null;
  if (notice) return `${notice.title}.`;
  if (preview.matched === 0 && preview.leftOutByStatus > 0) return "Only draft or archived products match.";
  if (preview.matched === 0) return "Nothing matches this scope.";

  const changing = changingLine(preview);
  const sentences = [`${changing.figure}${changing.rest}`];
  const example = exampleRowFrom(preview.rows);
  if (example?.before && example.after) {
    sentences.push(`${example.title} would go from ${example.before} to ${example.after}.`);
  }
  if (preview.skipped > 0) sentences.push(`${formatCount(preview.skipped)} would be left alone.`);
  if (preview.withoutBaseline > 0) sentences.push(withoutBaselineLine(preview.withoutBaseline));
  return sentences.join(" ");
}

/**
 * The count lines, worded once for the panel that shows them and the region that says them
 * (#1097), each agreeing with its own number. The panel wrote "1 of 1 variants" and "1 have no
 * baseline yet" while the region said them in the singular: two wordings of one answer, and
 * only the spoken one had been brought into line with #759.
 *
 * The figure apart from the rest, because the panel sets it in bold.
 */
function changingLine(preview: Pick<Preview, "changing" | "matched">): { figure: string; rest: string } {
  return { figure: formatCount(preview.changing), rest: ` of ${countOf(preview.matched, "variant")} would change price.` };
}

function withoutBaselineLine(count: number): string {
  return count === 1
    ? "1 has no baseline yet, so it cannot be priced at all."
    : `${formatCount(count)} have no baseline yet, so they cannot be priced at all.`;
}

interface DraftPreviewProps {
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
}

function PreviewBody({ preview, pending = false, surface, fullPreviewHref }: DraftPreviewProps) {
  if (!preview) {
    return (
      <Secondary>
        {/* "Set a rule" is wrong while one is being priced — and on first load a rule
            is already set, so it would be wrong immediately. The panel used to be
            primed by the loader, which is what made that sentence unreachable; asking
            from the client instead (#468) makes this the first thing a merchant reads,
            for about a second. */}
        {pending ? "Working out what this would do…" : "Set a rule to see what it would do."}
      </Secondary>
    );
  }

  // The rule's amount is empty, not a number, or no price at all (#696): nothing to show
  // but why, where the merchant is typing it.
  if (preview.ruleProblem) {
    return (
      <s-banner tone="critical">
        <s-paragraph>{preview.ruleProblem}</s-paragraph>
      </s-banner>
    );
  }

  if (preview.blocked) {
    return (
      <s-banner tone="critical">
        {/* Each blocking variant by name, its price and its floor, and what to do (#1076). */}
        <s-paragraph>{preview.blocked.message}</s-paragraph>
      </s-banner>
    );
  }

  // No catalogue to match against yet: not the merchant's conditions (#800).
  const notice = preview.catalogue ? catalogueNotice(preview.catalogue) : null;
  if (notice) return <EmptyState {...notice} />;

  // Everything the conditions match is on a draft or archived product (#751). Said as that
  // rather than as "nothing matches": the conditions are right, and the way in is the two
  // boxes under them, not loosening anything.
  if (preview.matched === 0 && preview.leftOutByStatus > 0) {
    return (
      <EmptyState
        title="Only draft or archived products match"
        description={`${leftOutSentence(preview.leftOutByStatus)} Tick “Include draft products” or “Include archived products” under the scope to price them.`}
      />
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
  const changing = changingLine(preview);

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
          <strong>{changing.figure}</strong>
          {changing.rest}
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
        <Secondary>
          {formatCount(preview.alreadyCorrect)} already at this price.
        </Secondary>
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
            {withoutBaselineLine(preview.withoutBaseline)} Sync your catalogue to capture{" "}
            {preview.withoutBaseline === 1 ? "it" : "them"}.
          </s-text>
        </s-paragraph>
      ) : null}
      {/* Secondary, not caution: leaving drafts and archived products out is the default
          working, not something to fix. It is said so a merchant who expected them knows
          where they went (#751). */}
      {preview.leftOutByStatus > 0 ? (
        <Secondary>{leftOutSentence(preview.leftOutByStatus)}</Secondary>
      ) : null}

      {/* Said once, above the table, rather than on every row that has one.
          
          A `live` figure means the storefront is not at the baseline, and there are two
          reasons for that: another campaign is pricing the variant, or somebody changed
          it outside the app. Claiming which on a row would be a guess — the resolver
          gave this row to *this* draft, so it does not know who priced it last — and
          `Prices → Drift` is where the app already answers the question properly.
          
          Absent when no row has drifted, which is the ordinary case. */}
      {/* Named on its own, ahead of the general note below: a stale baseline is not "another
          campaign is pricing it", and the drift queue that note points to never lists it,
          because drift is only watched while a campaign runs (#745). */}
      {preview.staleBaselines > 0 ? (
        <s-banner tone="warning">
          <s-paragraph>
            {formatCount(preview.staleBaselines)} of the prices this would change{" "}
            {preview.staleBaselines === 1 ? "was" : "were"} changed outside this app while no
            campaign was running on {preview.staleBaselines === 1 ? "it" : "them"}, so{" "}
            {preview.staleBaselines === 1 ? "its baseline is" : "their baselines are"} out of
            date. This sale would discount from the old price, and ending it would put the old
            price back. Recapture {preview.staleBaselines === 1 ? "that baseline" : "those baselines"}{" "}
            first if the new price is the normal one.
          </s-paragraph>
          <s-button href="/app/prices/baselines/recapture?segment=stale">Recapture baselines</s-button>
        </s-banner>
      ) : null}

      {preview.rows.some((row) => row.live) ? (
        <s-stack gap={SPACE.tight}>
          <Secondary>
            Some of these show a <s-text type="strong">live</s-text> price that is not
            their baseline: either another campaign is pricing them, or the storefront
            was changed outside this app.
          </Secondary>
          {/* A tertiary button, not a link. `ActionRow`'s vocabulary reserves blue text
              for a word *inside* a sentence where colour is doing necessary work; this
              is a standalone way out of the card, which is what tertiary is for. */}
          <ActionRow>
            <s-button variant="secondary" href="/app/prices/drift">
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
                would put the two halves of a before-and-after on separate lines.

                "Becomes", the same word the full-preview route uses for this column.
                They are two views of one draft — this panel's "See all N rows" is what
                opens that page — and they had two names for the column a merchant goes
                there to check. It is also two syllables shorter, which matters here:
                once the compare-at moved under the price the column narrowed, and
                "Would become" started wrapping onto two lines in the header. */}
            <s-table-header listSlot="inline" format="currency">Becomes</s-table-header>
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
                  <MoneyCell
                    amount={row.before}
                    compareAt={row.beforeCompareAt}
                    /* Only when the storefront disagrees with the baseline, which means
                       the variant is mid-campaign or has drifted. Silence is the ordinary
                       case; a merchant reading "40.00 becomes 32.00" beside a storefront
                       showing 28.00 needs to be told which number we are working from. */
                    note={
                      row.live ? <s-text tone="caution">live {row.live}</s-text> : undefined
                    }
                  />
                </s-table-cell>
                <s-table-cell>
                  {row.skippedReason ? (
                    <s-text tone="caution">{row.skippedReason}</s-text>
                  ) : row.unchanged ? (
                    <s-text color="subdued">no change</s-text>
                  ) : (
                    <MoneyCell amount={row.after} compareAt={row.afterCompareAt} />
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
              <s-button variant="secondary" href={fullPreviewHref}>
                See all {formatCount(preview.changing + preview.alreadyCorrect + preview.skipped)} rows
              </s-button>
            </ActionRow>
          ) : null}
        </s-stack>
      ) : null}
    </s-stack>
  );
}

/** The variants a scope leaves out by product status, in one sentence (#751). */
function leftOutSentence(count: number): string {
  return count === 1
    ? "1 variant on a draft or archived product is left out."
    : `${formatCount(count)} variants on draft or archived products are left out.`;
}
