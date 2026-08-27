import { formatAgo, formatCount } from "../lib/format/display";
import { HAIRLINE, PAD, SPACE } from "../lib/ui/spacing";
import { RUN_TONE, toneFor } from "./tone";

/**
 * The last thing the app did to the storefront.
 *
 * This is the sentence a merchant opens the dashboard to read, and it used to be an
 * actual sentence: *Last run: apply of "Summer sale" — completed, 412 verified on
 * 27/08/2026, 12:40:38.* Everything is in there, in the order the code happened to have
 * it, and the two things being looked for — did it go cleanly, and was that recently —
 * are the fifth and last words of a clause.
 *
 * As a row those two are the first and last things on it: the outcome as a toned badge on
 * the left, where a status belongs, and the time on the right in words. What is left in
 * the middle is the campaign's name, which is the only part that was ever prose.
 *
 * `PARTIAL` is a warning and never a success, per `RUN_TONE` — a run that did not verify
 * every row is the exact state this product exists to make visible.
 */
export function LastRunSummary({
  run,
  now,
  timeZone,
}: {
  run: {
    kind: string;
    status: string;
    verified: number;
    failed: number;
    finishedAt: string | null;
    campaignId: string;
    campaignName: string;
  };
  now: string;
  timeZone: string;
}) {
  return (
    <s-box
      padding={PAD.card}
      borderWidth={HAIRLINE.borderWidth}
      borderStyle={HAIRLINE.borderStyle}
      borderColor={HAIRLINE.borderColor}
      borderRadius="base"
    >
      <s-grid
        // One comma only: Polaris reads the comma as the separator between the responsive
        // value and the default, so a second one anywhere stops the value parsing.
        gridTemplateColumns="@container (inline-size <= 560px) auto 1fr, auto 1fr auto"
        gap={SPACE.item}
        alignItems="center"
      >
        <s-badge tone={toneFor(RUN_TONE, run.status)}>{sentence(run.status)}</s-badge>

        <s-stack gap={SPACE.tight}>
          <s-text type="strong">{run.campaignName}</s-text>
          <s-text color="subdued">
            {run.kind.toLowerCase()} · {formatCount(run.verified)} verified
            {run.failed > 0 ? `, ${formatCount(run.failed)} failed` : ""}
            {run.finishedAt ? ` · ${formatAgo(run.finishedAt, now, timeZone)}` : " · still running"}
          </s-text>
        </s-stack>

        <s-button variant="tertiary" href={`/app/campaigns/${run.campaignId}`}>
          View campaign
        </s-button>
      </s-grid>
    </s-box>
  );
}

/** `COMPLETED` is a database value; "Completed" is a word. */
function sentence(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}
