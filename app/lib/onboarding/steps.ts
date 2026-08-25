/**
 * Getting a merchant to their first completed campaign.
 *
 * The goal is explicit and measurable: a first verified-clean campaign within ten
 * minutes of install, unassisted. That is not a UI polish target — the baseline concept
 * is unfamiliar, the app's entire value depends on the merchant understanding it, and
 * nobody reads the docs first. So the teaching happens in the flow or it does not
 * happen.
 *
 * The checklist is derived from what the shop has actually done rather than from
 * "steps dismissed". A merchant who clicked past a step has not captured baselines, and
 * a checklist that believed otherwise would be lying about whether the app can price
 * anything.
 */

export type StepId = "sync" | "practice" | "campaign" | "done";

export interface OnboardingFacts {
  /** Baselines exist, so campaigns can compute from something. */
  hasBaselines: boolean;
  /** A campaign has been created, whether or not it ran. */
  hasCampaign: boolean;
  /** A practice run has been previewed — optional, but it is the confidence step. */
  hasPracticed: boolean;
  /** A real campaign has finished with every row verified. This is the goal. */
  hasCleanRun: boolean;
}

export interface OnboardingStep {
  id: StepId;
  title: string;
  /** Why this exists, in the merchant's terms. The teaching, not the instruction. */
  detail: string;
  done: boolean;
  /** Where to go. Absent for a step that is already complete. */
  href?: string;
  cta?: string;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  /** The step to lead with. Null once everything is done. */
  next: OnboardingStep | null;
  /** True once the merchant has a verified-clean campaign; the card retires. */
  complete: boolean;
}

export function onboarding(facts: OnboardingFacts): OnboardingState {
  const steps: OnboardingStep[] = [
    {
      id: "sync",
      title: "Capture your baselines",
      detail:
        "Anchor works out every price from a baseline — your normal price for each variant — " +
        "not from whatever price is live today. That is what makes running a sale twice " +
        "harmless, and what makes ending one exact. Syncing records today's prices as those " +
        "baselines and changes nothing on your storefront.",
      done: facts.hasBaselines,
      href: facts.hasBaselines ? undefined : "/app",
      cta: facts.hasBaselines ? undefined : "Sync catalogue",
    },
    {
      id: "practice",
      title: "Try one in practice mode",
      detail:
        "A practice campaign runs the whole thing — scope, rule, preview — and writes " +
        "absolutely nothing. It is the way to see exactly what would change before anything " +
        "does, which is worth doing once on a catalogue you cannot afford to get wrong.",
      done: facts.hasPracticed,
      href: facts.hasPracticed ? undefined : "/app/campaigns/new?practice=1",
      cta: facts.hasPracticed ? undefined : "Start a practice campaign",
    },
    {
      id: "campaign",
      title: "Run your first real campaign",
      detail:
        "Start small — five products is plenty. You will see every price that would change " +
        "before you apply, and every row that did change afterwards. Reverting recomputes " +
        "each price without the campaign rather than restoring a saved number, so it is " +
        "exact even if something else changed meanwhile.",
      done: facts.hasCleanRun,
      href: facts.hasCleanRun ? undefined : "/app/campaigns/new?guided=1",
      cta: facts.hasCleanRun ? undefined : "Create a guided campaign",
    },
  ];

  // The first thing not done, in order. Practice is skippable and the order reflects
  // that: a merchant who has already made a campaign is past it, and nagging them back
  // to a step they deliberately stepped over is how a checklist becomes noise.
  const next =
    steps.find((step) => !step.done && !(step.id === "practice" && facts.hasCampaign)) ?? null;

  return { steps, next, complete: facts.hasCleanRun };
}

/** Products a guided first campaign is capped at, so the first run is small and quick. */
export const GUIDED_PRODUCT_LIMIT = 5;
