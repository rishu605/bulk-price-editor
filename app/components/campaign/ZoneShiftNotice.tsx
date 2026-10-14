import { ActionRow } from "../ActionRow";
import { describeZoneShift, type ZoneShift } from "../../lib/scheduling/zone-shift";
import type { CampaignDetailProps } from "./props";

/**
 * A campaign whose times now read differently on the store's clock, and the two ways to
 * settle it (#799).
 *
 * Its instants did not move -- they never do -- but the store's zone did: the merchant
 * changed it in Shopify, or Anchor had it as UTC until it read the real one. A 9 AM sale
 * now opens at 4 AM, and before this the only sign was the zone in brackets after the
 * time. Neither button writes a price; both say what they did in the page's banner.
 *
 * Forms rather than `fetcher.submit`, like Resume beside it: this sits outside the menu
 * whose popover drops a nested form.
 */
export function ZoneShiftNotice({
  zoneShift,
  fetcher,
  busy,
}: Pick<CampaignDetailProps, "fetcher" | "busy"> & { zoneShift: ZoneShift }) {
  return (
    <s-banner tone="warning" heading="This campaign now runs at a different time of day">
      <s-paragraph>{describeZoneShift(zoneShift)}</s-paragraph>
      <s-paragraph>
        Keep the times you set to move it to the same time of day on your store&rsquo;s clock,
        or keep the new times to leave it where it is.
      </s-paragraph>
      <ActionRow>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="keep-typed-time" />
          <s-button type="submit" loading={busy || undefined}>
            Keep the times you set
          </s-button>
        </fetcher.Form>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="keep-shown-time" />
          <input type="hidden" name="zone" value={zoneShift.to} />
          <s-button type="submit" variant="secondary" loading={busy || undefined}>
            Keep the new times
          </s-button>
        </fetcher.Form>
      </ActionRow>
    </s-banner>
  );
}
