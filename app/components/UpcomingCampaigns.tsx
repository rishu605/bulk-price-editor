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
    // One grid for every row, not a grid per row. Columns sized per row would place each
    // campaign's name wherever its own badge happened to end — "Active" and "Scheduled"
    // are different widths — and three names at three different distances from the edge
    // read as three unrelated things rather than as a list.
    //
    // One comma only: Polaris reads it as the separator between the responsive value and
    // the default, so a second one stops the value parsing.
    <s-grid
      gridTemplateColumns="@container (inline-size <= 520px) auto 1fr, auto 1fr auto"
      gap={SPACE.item}
      alignItems="center"
    >
      {moments.map((moment) => (
        <Fragment key={`${moment.id}-${moment.kind}`}>
          <s-badge tone={toneFor(CAMPAIGN_TONE, moment.status)}>
            {humanise(moment.status)}
          </s-badge>

          <s-button variant="tertiary" href={`/app/campaigns/${moment.id}`}>
            {moment.name}
          </s-button>

          {/* The timing is pinned to the far edge, so the column of "in 3 days" reads
              down the page as one thing whatever the names do. */}
          <s-text color="subdued">
            {moment.kind === "starts" ? "starts" : "ends"} {formatAgo(moment.at, now, timeZone)}
          </s-text>
        </Fragment>
      ))}
    </s-grid>
  );
}
