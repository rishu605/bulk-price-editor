import { formatCount } from "../lib/format/display";
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
export function DraftPreview({ preview }: { preview: Preview | null }) {
  if (!preview) {
    return (
      <s-paragraph>
        <s-text color="subdued">Set a rule to see what it would do.</s-text>
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
      <s-paragraph>
        <s-text color="subdued">Nothing matches this scope yet.</s-text>
      </s-paragraph>
    );
  }

  return (
    <s-stack gap={SPACE.section}>
      <s-paragraph>
        <s-text>
          <strong>{formatCount(preview.changing)}</strong> of {formatCount(preview.matched)}{" "}
          variants would change price.
        </s-text>
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

      {preview.rows.length > 0 ? (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Variant</s-table-header>
            <s-table-header listSlot="inline" format="currency">Now</s-table-header>
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
                  {row.before ?? "—"}
                  {row.beforeCompareAt ? ` (was ${row.beforeCompareAt})` : ""}
                </s-table-cell>
                <s-table-cell>
                  {row.skippedReason ? (
                    <s-text tone="caution">{row.skippedReason}</s-text>
                  ) : row.unchanged ? (
                    <s-text color="subdued">no change</s-text>
                  ) : (
                    <s-text>
                      {row.after ?? "—"}
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
        <s-paragraph>
          <s-text color="subdued">
            Showing the first {formatCount(preview.rows.length)}. Every row is priced the
            same way.
          </s-text>
        </s-paragraph>
      ) : null}
    </s-stack>
  );
}
