/**
 * What each plan includes, and — more importantly — what it never gates.
 *
 * Pricing meters **variants under management and surfaces**, not changes (decision D3).
 * Change metering is the category norm and it taxes the core loop: it charges a merchant
 * for using the product, and makes recurring campaigns — the thing that differentiates
 * this app — the most expensive way to use it.
 *
 * **Safety is never paywalled.** Preview, guardrails, the full history, and rollback are
 * on every tier including free. Charging for the ability to undo a mistake the app helped
 * make is indefensible, and a free-tier merchant stranded at sale prices is a support
 * incident and a one-star review regardless of what they were paying.
 *
 * That principle has a sharp edge, which is the whole of edge case E8: a merchant who
 * downgrades mid-campaign must still get their scheduled revert. Gates therefore
 * constrain what can be *started*, never what can be *finished*. `canRevert` does not
 * exist in this module because there is no plan on which the answer is no.
 */

export type PlanId = "free" | "growth" | "markets" | "wholesale";

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in USD minor units. Zero for free. */
  priceMinor: number;
  /** Variants a campaign may manage. Null means no limit. */
  variantLimit: number | null;
  /** Market price lists may be targeted. */
  markets: boolean;
  /** B2B catalogues may be targeted. */
  b2b: boolean;
  /** Trial length in days, applied on first subscribe. */
  trialDays: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceMinor: 0,
    // Enough to run a real campaign on a small catalogue rather than a demo. A cap that
    // only permits a toy makes the free tier a advertisement rather than a product, and
    // the merchants who most need the safety features are the ones on it.
    variantLimit: 500,
    markets: false,
    b2b: false,
    trialDays: 0,
  },
  growth: {
    id: "growth",
    name: "Growth",
    priceMinor: 1490,
    variantLimit: 10_000,
    markets: false,
    b2b: false,
    trialDays: 14,
  },
  markets: {
    id: "markets",
    name: "Markets",
    priceMinor: 3490,
    variantLimit: 100_000,
    markets: true,
    b2b: false,
    trialDays: 14,
  },
  wholesale: {
    id: "wholesale",
    name: "Wholesale",
    priceMinor: 6990,
    variantLimit: null,
    markets: true,
    b2b: true,
    trialDays: 14,
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "growth", "markets", "wholesale"];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && value in PLANS;
}

/** The plan a shop is on, defaulting to free rather than to an error. */
export function planFor(id: unknown): Plan {
  return isPlanId(id) ? PLANS[id] : PLANS.free;
}

export type GateReason = "variant-limit" | "markets" | "b2b";

export interface Gated {
  allowed: false;
  reason: GateReason;
  /** The cheapest plan that would allow it, or null if none does. */
  upgradeTo: PlanId | null;
  message: string;
}

export type Entitlement = { allowed: true } | Gated;

const ALLOWED: Entitlement = { allowed: true };

export interface CampaignShape {
  /** Variants the campaign would manage. */
  variants: number;
  /** Whether it targets any market price list. */
  markets: boolean;
  /** Whether it targets any B2B catalogue. */
  b2b: boolean;
}

/**
 * Whether a plan allows a campaign to *start*.
 *
 * Checked when a campaign is created and again when it is applied, because a merchant's
 * catalogue grows and a plan can change between the two. Never checked on revert — see
 * the note at the top of this file.
 */
export function canStart(plan: Plan, shape: CampaignShape): Entitlement {
  if (shape.b2b && !plan.b2b) {
    return gate("b2b", cheapestWith((candidate) => candidate.b2b), plan);
  }

  if (shape.markets && !plan.markets) {
    return gate("markets", cheapestWith((candidate) => candidate.markets), plan);
  }

  if (plan.variantLimit !== null && shape.variants > plan.variantLimit) {
    return gate(
      "variant-limit",
      cheapestWith((candidate) => candidate.variantLimit === null || candidate.variantLimit >= shape.variants),
      plan,
      shape.variants,
    );
  }

  return ALLOWED;
}

/**
 * Whether a plan allows a surface to be *chosen*.
 *
 * Separate from `canStart` so the wizard can show a gated market with an upgrade prompt
 * rather than hiding it. Hiding a feature a merchant is paying a competitor for is how
 * you lose them without ever learning why.
 */
export function canUseSurface(plan: Plan, kind: "base" | "market" | "b2b"): Entitlement {
  if (kind === "market" && !plan.markets) {
    return gate("markets", cheapestWith((candidate) => candidate.markets), plan);
  }
  if (kind === "b2b" && !plan.b2b) {
    return gate("b2b", cheapestWith((candidate) => candidate.b2b), plan);
  }
  return ALLOWED;
}

function cheapestWith(predicate: (plan: Plan) => boolean): PlanId | null {
  for (const id of PLAN_ORDER) {
    if (predicate(PLANS[id])) return id;
  }
  return null;
}

function gate(reason: GateReason, upgradeTo: PlanId | null, plan: Plan, variants?: number): Gated {
  const target = upgradeTo ? PLANS[upgradeTo] : null;
  const suffix = target
    ? ` ${target.name} includes it.`
    : " No plan covers a catalogue this size — get in touch and we will sort something out.";

  const messages: Record<GateReason, string> = {
    "variant-limit":
      `Your ${plan.name} plan manages up to ${plan.variantLimit?.toLocaleString()} variants ` +
      `and this campaign covers ${variants?.toLocaleString()}.`,
    markets: `Pricing into markets is not part of ${plan.name}.`,
    b2b: `Pricing into wholesale catalogues is not part of ${plan.name}.`,
  };

  return { allowed: false, reason, upgradeTo, message: messages[reason] + suffix };
}

/**
 * Whether moving between two plans loses something.
 *
 * Used to tell a merchant what a downgrade will stop them starting — never to stop the
 * downgrade, and never to touch what is already running.
 */
export function losesOnDowngrade(from: Plan, to: Plan): GateReason[] {
  const lost: GateReason[] = [];

  if (from.markets && !to.markets) lost.push("markets");
  if (from.b2b && !to.b2b) lost.push("b2b");
  if (from.variantLimit === null ? to.variantLimit !== null : (to.variantLimit ?? Infinity) < from.variantLimit) {
    lost.push("variant-limit");
  }

  return lost;
}
