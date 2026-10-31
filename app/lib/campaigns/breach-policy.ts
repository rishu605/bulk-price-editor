/**
 * Which floor-breach policy a campaign plans and runs with, and how to say so (#789).
 *
 * Settings' "When a price would breach a floor" was copied onto a campaign when it was
 * created and never read again, while the floors themselves are read live. A merchant who
 * switched to Block after an incident still had every existing campaign clamping -- scheduled
 * ones that had written nothing included -- and with a floor over a price, clamping raises it.
 *
 * The copy exists so changing the store's setting does not change what a running campaign does
 * to prices already on a storefront (#338). A campaign with none of its prices up has nothing to
 * keep, so it follows the store's setting; from the moment it starts it keeps the one it started
 * with, until it ends. Pure, and the one place that is decided: the planner, the campaign page,
 * the Apply dialog and Settings all ask it, so the policy the page names is the one the plan used
 * (rule 4).
 */

import { pricesMayBeLive, type CampaignState } from "../lifecycle/transitions";
import type { GuardrailViolationPolicy } from "../pricing/types";

/** Each policy in the words of the Settings field, so every page names it the same way. */
export const BREACH_POLICY_LABELS: Readonly<Record<GuardrailViolationPolicy, string>> = {
  clamp: "Clamp it to the floor and carry on",
  skip: "Skip that variant, price the rest",
  block: "Block the whole campaign",
};

/** What Settings says the field applies to, and what it does not. */
export const BREACH_POLICY_REACH =
  "Applies to new campaigns and anything not yet started. A campaign that is running keeps the policy it started with until it ends.";

export interface BreachPolicy {
  /** What the campaign does when a price would breach a floor: what it is planned, and run, with. */
  policy: GuardrailViolationPolicy;
  /**
   * True while its prices may be live -- applying, active, held, partial, reverting -- when it
   * keeps the policy it started with. False before it starts, or once it has ended, when it
   * follows the store's.
   */
  kept: boolean;
  /** The store's setting as it is now. */
  store: GuardrailViolationPolicy;
}

/** The policy a campaign in `state` runs with, given its own and the store's. */
export function breachPolicyFor(
  state: CampaignState,
  own: GuardrailViolationPolicy,
  store: GuardrailViolationPolicy,
): BreachPolicy {
  const kept = pricesMayBeLive(state);
  return { policy: kept ? own : store, kept, store };
}

/** Whether a move into `to` starts a campaign: it now keeps the store's policy as it is (#789). */
export function startsKeepingPolicy(from: CampaignState, to: CampaignState): boolean {
  return pricesMayBeLive(to) && !pricesMayBeLive(from);
}

/** The line beside the policy on the campaign page. */
export function breachPolicyDetail({ kept, policy, store }: BreachPolicy): string {
  if (!kept) {
    return "The store's setting, which this campaign follows until it starts. From then it keeps it until it ends.";
  }
  return policy === store
    ? "The one it started with, which it keeps until it ends, whatever Settings says."
    : `The one it started with, which it keeps until it ends. Settings now says “${BREACH_POLICY_LABELS[store]}”, ` +
        "for new campaigns and anything not yet started.";
}

/**
 * The policy as the Apply dialog restates it. Applying is the moment one that has not started
 * takes the store's for good, so it says so; one already running keeps its own.
 */
export function breachPolicyAtApply({ kept, policy, store }: BreachPolicy): string {
  const label = BREACH_POLICY_LABELS[policy];
  if (!kept) return `${label}: the store's setting, which this campaign keeps until it ends`;
  return policy === store
    ? `${label}: the one it started with`
    : `${label}: the one it started with. Settings now says “${BREACH_POLICY_LABELS[store]}”, which it does not follow`;
}
