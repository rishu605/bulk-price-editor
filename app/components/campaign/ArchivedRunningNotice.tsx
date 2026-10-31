import { formatCount } from "../../lib/format/display";
import { ActionRow } from "../ActionRow";

/**
 * The archived campaigns still live or scheduled, counted where the list leaves them out (#748).
 *
 * Archiving files a campaign away without ending it. An archived Active campaign's prices
 * stayed live while it left the list and its Active filter, and an archived scheduled one still
 * starts on its date, so the list could no longer account for a price on the storefront. Home
 * said so (#723); the list it links to did not.
 *
 * Info, not a warning: archiving it was a decision the merchant has made, after being told
 * what it leaves running. What this owes them is that it is never out of sight.
 */
export function ArchivedRunningNotice({ count, href }: { count: number; href: string }) {
  if (count === 0) return null;
  const one = count === 1;
  return (
    <s-banner tone="info">
      <s-paragraph>
        {one
          ? "1 archived campaign is still live or scheduled. "
          : `${formatCount(count)} archived campaigns are still live or scheduled. `}
        Archiving took {one ? "it" : "them"} out of this list without ending {one ? "it" : "them"}:{" "}
        {one ? "its" : "their"} prices stay live, or go live on {one ? "its" : "their"} start date.
      </s-paragraph>
      <ActionRow>
        <s-button href={href}>{one ? "Show it" : "Show them"}</s-button>
      </ActionRow>
    </s-banner>
  );
}
