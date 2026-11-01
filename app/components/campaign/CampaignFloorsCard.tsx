import { BREACH_POLICY_LABELS, breachPolicyDetail } from "../../lib/campaigns/breach-policy";
import { SPACE } from "../../lib/ui/spacing";
import { Card } from "../Card";
import { Fact } from "../Fact";
import { CampaignFloorsFields } from "./CampaignFloorsFields";
import type { CampaignDetailProps } from "./props";

/**
 * "Floors" on the Overview tab: which floors this campaign is planned with and whose they are,
 * the policy it runs with (#789), and the fields that change them (#816).
 *
 * Its floors can be changed in any state but while a run is writing it. Going below the
 * store's asks for the word whether or not it has started: a running campaign's next apply,
 * resume or new product is written at the floor it has then. Its policy only until it starts,
 * after which it keeps the one it started with (D21).
 */
export function CampaignFloorsCard({ floors, breachPolicy, state, fetcher, busy }: CampaignDetailProps) {
  const writing = state === "APPLYING" || state === "REVERTING";
  // The save's question, when what was typed goes below the store's: asked beside its box.
  const reply = fetcher.data;
  const ask = reply && "loosen" in reply && typeof reply.loosen === "string" ? reply.loosen : null;

  return (
    <Card heading="Floors">
      <Fact label="Floors that apply" detail={floors.whose}>
        <s-text>{floors.applied}</s-text>
      </Fact>
      {floors.unconfirmed ? (
        <s-banner tone="warning">
          <s-paragraph>{floors.unconfirmed}</s-paragraph>
        </s-banner>
      ) : null}

      {/* Which policy it plans and runs with, and whose (#789). Nothing on the page said, and a
          campaign made before the merchant chose Block went on clamping under it. */}
      <Fact label="When a price would breach a floor" detail={breachPolicyDetail(breachPolicy)}>
        <s-text>{BREACH_POLICY_LABELS[breachPolicy.policy]}</s-text>
      </Fact>

      {writing || state === "CANCELLED" ? null : (
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="floors" />
          <s-stack gap={SPACE.item}>
            <CampaignFloorsFields
              currency={floors.currency}
              initial={floors.fields}
              storeFloors={floors.store}
              storePolicy={breachPolicy.store}
              // A campaign that has started keeps the policy it started with until it ends (D21).
              policyKept={breachPolicy.kept ? `${BREACH_POLICY_LABELS[breachPolicy.policy]}, until it ends` : undefined}
              ask={ask}
            />
            <s-stack direction="inline" gap={SPACE.item} justifyContent="end">
              <s-button type="submit" variant="secondary" loading={busy || undefined}>
                Save floors
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      )}
    </Card>
  );
}
