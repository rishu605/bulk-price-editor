/**
 * Status, schedule and auto-enrolment.
 *
 * These were three separate aside panels. They answer the same question -- what is this
 * campaign doing and when -- so they are one tab.
 */

import type { CampaignDetailProps } from "./props";

export function CampaignOverviewTab({ scheduleText, warnings, autoEnroll, enrollPendingAt, lifecycle, history }: CampaignDetailProps) {
  return (
    <>
      <s-section heading="Status">
        <s-paragraph>
          <s-badge tone={lifecycle.tone}>{lifecycle.label}</s-badge>
        </s-paragraph>
        <s-paragraph>
          <s-text>{lifecycle.explanation}</s-text>
        </s-paragraph>

        {history.length > 0 ? (
          <>
            <s-divider />
            <s-paragraph>
              <s-text>How it got here</s-text>
            </s-paragraph>
            {history.map((entry) => (
              <s-paragraph key={`${entry.at}-${entry.to}`}>
                <s-text>
                  {entry.from} → {entry.to} · {entry.reason || entry.actor}
                </s-text>
              </s-paragraph>
            ))}
          </>
        ) : null}
      </s-section>
      <s-section heading="Schedule">
        <s-paragraph>{scheduleText}</s-paragraph>
        {warnings.map((warning) => (
          <s-banner key={warning} tone="warning">
            <s-paragraph>{warning}</s-paragraph>
          </s-banner>
        ))}
      </s-section>

      <s-section heading="New products">
        <s-paragraph>
          {autoEnroll
            ? "Products that enter this campaign's scope while it runs are priced automatically, from their own normal price."
            : "Products added while this campaign runs are left at their current price."}
        </s-paragraph>
        {enrollPendingAt ? (
          <s-banner tone="info">
            <s-paragraph>
              New products found; they are priced on the next scheduler run.
            </s-paragraph>
          </s-banner>
        ) : null}
      </s-section>
    </>
  );
}
