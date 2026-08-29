/**
 * Status, schedule and auto-enrolment.
 *
 * These were three separate aside panels. They answer the same question -- what is this
 * campaign doing and when -- so they are one tab.
 */

import { formatWhen } from "../../lib/format/display";
import { Blank } from "../Blank";
import { describeActor } from "../../lib/audit/actor";
import { ALL_STATES, describeState } from "../../lib/lifecycle/transitions";
import { humanise } from "../../lib/format/label";
import { CampaignNote } from "./CampaignNote";
import type { CampaignDetailProps } from "./props";

export function CampaignOverviewTab(props: CampaignDetailProps) {
  const {
    scheduleText,
    warnings,
    autoEnroll,
    enrollPendingAt,
    lifecycle,
    history,
    timeZone,
  } = props;

  return (
    <>
      <s-section heading="Status">
        <s-paragraph>
          <s-badge tone={lifecycle.tone}>{lifecycle.label}</s-badge>
        </s-paragraph>
        <s-paragraph>
          <s-text>{lifecycle.explanation}</s-text>
        </s-paragraph>
      </s-section>

      {/* Above the history, because the note is why the history happened. */}
      <CampaignNote {...props} />

      {history.length > 0 ? (
        // Its own section rather than a run of paragraphs under a bare `s-paragraph`
        // acting as a heading. Three things were wrong with what was here, and all three
        // are the kind of thing a merchant reads as "this screen is for someone else":
        //
        //  - the states were the database's — `DRAFT → ACTIVE`, which is what #381 swept
        //    out of every badge in the app and did not reach here;
        //  - the actor was the raw staff id, where every other surface says "Scheduler"
        //    or names the account;
        //  - `at` was loaded, carried through the loader, and never rendered, so the one
        //    column a history is *for* was missing.
        <s-section heading="How it got here">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="kicker">When</s-table-header>
              <s-table-header listSlot="primary">Change</s-table-header>
              <s-table-header listSlot="secondary">Why</s-table-header>
              <s-table-header listSlot="inline">Who</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {history.map((entry) => (
                <s-table-row key={`${entry.at}-${entry.to}`}>
                  <s-table-cell>{formatWhen(entry.at, timeZone)}</s-table-cell>
                  <s-table-cell>
                    {stateName(entry.from)} → {stateName(entry.to)}
                  </s-table-cell>
                  <s-table-cell>{entry.reason || <Blank />}</s-table-cell>
                  <s-table-cell>{describeActor(entry.actor)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}

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

/**
 * A state out of the audit log, named the way the rest of the app names it.
 *
 * Guarded, because `describeState` has no default branch: the audit entry's `from` is
 * `"—"` for the transition that created the campaign, and calling it with that returns
 * `undefined` and throws on `.label`. `humanise` is the same fallback the activity log
 * uses for an action nobody anticipated — a readable phrase beats a crash, and beats a
 * lookup table that goes stale the first time a state is added.
 */
function stateName(state: string): string {
  return ALL_STATES.includes(state as never)
    ? describeState(state as never).label
    : humanise(state);
}
