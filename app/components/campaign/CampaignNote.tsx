/**
 * Why this campaign exists, in the merchant's own words.
 *
 * The cheapest possible answer to the question every audit asks, and the one thing on
 * this page nothing else can reconstruct. The ledger says exactly what was written and
 * the activity log says who asked for it; neither says why, and six weeks later "why"
 * is the only part anybody has forgotten.
 *
 * Sami has this and neither of the other two does, which is the shape of most of what
 * they get right: not a pricing feature, a record-keeping one.
 *
 * ## Why it is always an open field
 *
 * No view mode with an Edit button. A note that has to be unlocked before it can be
 * corrected is a note that stays wrong — and there is nothing to protect here, since the
 * previous text is kept in the audit log either way. The empty state is a placeholder
 * asking the question rather than a heading announcing there is no note, because an
 * empty text field already says that.
 */

import { SPACE } from "../../lib/ui/spacing";
import type { CampaignDetailProps } from "./props";
import { Card } from "../Card";

export function CampaignNote({ note, fetcher, busy }: CampaignDetailProps) {
  return (
    <Card heading="Why this campaign exists">  <fetcher.Form method="post">
        <input type="hidden" name="intent" value="note" />
        <s-stack direction="block" gap={SPACE.item}>
          <s-text-area
            name="note"
            label="Note"
            labelAccessibilityVisibility="exclusive"
            rows={3}
            // `value`, not `defaultValue`: a Polaris web component ignores the React
            // default and renders an empty box, which here would look exactly like a
            // campaign that has no note. `polaris-traps.test.ts` catches it.
            value={note ?? ""}
            placeholder="Matching a competitor on outerwear until the end of the season. Agreed with Priya."
            details="Searchable from the campaigns list, and kept when this campaign is archived."
          />
          {/* Right where the field ends, not in the page header. This is a note about a
              campaign, not an action on it, and putting Save beside Apply would be two
              very different consequences on one row. */}
          <s-stack direction="inline" gap={SPACE.item} justifyContent="end">
            <s-button type="submit" variant="secondary" loading={busy || undefined}>
              Save note
            </s-button>
          </s-stack>
        </s-stack>
      </fetcher.Form>
    </Card>
  );
}
