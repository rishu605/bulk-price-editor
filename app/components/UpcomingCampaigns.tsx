import { Fragment } from "react";

import { formatAgo } from "../lib/format/display";
import { humanise } from "../lib/format/label";
import type { NextMoment } from "../lib/scheduling/upcoming";
import { SPACE } from "../lib/ui/spacing";
import { CAMPAIGN_TONE, toneFor } from "./tone";

/**
 * The next few things that will change a price, in the order they will happen.
 *
 * The dashboard used to report this as "Scheduled: 1". For a product whose whole subject
 * is *when*, a count is the one shape that cannot answer the question a merchant opens
 * the page with — is anything about to change my prices, and have I got time to stop it.
 *
 * Ends are listed alongside starts. A revert changes prices exactly as much as an apply
 * does, and a merchant is far likelier to have forgotten one is coming.
 *
 * ## Two columns, with the timing on its own row
 *
 * This lives in Home's aside now, which is a 22rem — 352px — column. It used to be three
 * columns across the full content width, with a container query dropping to two below
 * 520px, and that narrow branch had never run anywhere: it is three cells per moment
 * flowing into two columns, so the timing of one campaign shared a row with the *next*
 * one's badge and every row after the first sat one cell out of step. Correct at the only
 * width it was ever rendered at, broken at the width it was written for.
 *
 * So there is one layout now rather than a choice between a good one and an untested one.
 * The badge and the name take a row, the timing spans both columns underneath, and it
 * holds from 352px up to the full width the aside takes when the page stacks under 900px.
 *
 * The badge column stays `auto`, which is the whole reason this is still a grid: "Active"
 * and "Scheduled" are different widths, so a badge inline with its name puts every
 * campaign's name at a different distance from the edge, and names at three different
 * distances read as three unrelated things rather than as a list. Measured against the
 * real components — inline, the two names start 26px apart; in this grid they share an
 * edge.
 */
export function UpcomingCampaigns({
  moments,
  now,
  timeZone,
}: {
  moments: NextMoment[];
  now: string;
  timeZone: string;
}) {
  return (
    <s-grid gridTemplateColumns="auto 1fr" gap={SPACE.item} alignItems="center">
      {moments.map((moment) => (
        <Fragment key={`${moment.id}-${moment.kind}`}>
          <s-badge tone={toneFor(CAMPAIGN_TONE, moment.status)}>
            {humanise(moment.status)}
          </s-badge>

          <s-link href={`/app/campaigns/${moment.id}`}>{moment.name}</s-link>

          {/* Spanning both columns, which is what keeps the list in step. Left in the
              flow as a third cell it would be pulled up beside the next campaign's
              badge — see the note above; that is the exact failure this replaces. */}
          <s-grid-item gridColumn="span 2">
            <s-text color="subdued">
              {moment.kind === "starts" ? "starts" : "ends"}{" "}
              {formatAgo(moment.at, now, timeZone)}
            </s-text>
          </s-grid-item>
        </Fragment>
      ))}
    </s-grid>
  );
}
