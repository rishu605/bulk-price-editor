/**
 * What Home shows, and why.
 *
 * These decisions were four conditionals scattered through the route's JSX, and nothing
 * checked any of them. That matters more than it looks: each exists because of a specific
 * way the page had previously embarrassed itself, and a conditional with no test is one
 * tidy-up away from being simplified back into the thing it was written to fix. The first
 * of them was mutated to `true` during review and the entire suite passed.
 *
 * Derived from facts rather than flags, the same way `onboarding()` is: a shop that has a
 * campaign has one whether or not anybody set a boolean saying so.
 */

export interface HomeFacts {
  /** The catalogue has never been synced, so there is nothing to count yet. */
  neverSynced: boolean;
  /** Campaigns that exist at all, in any state. */
  campaigns: number;
  /** Whether any run has ever happened. */
  hasRun: boolean;
  /** The getting-started checklist has retired itself. */
  onboardingComplete: boolean;
}

export interface HomeSections {
  /**
   * "What is live right now".
   *
   * It used to render unconditionally, so a shop that had synced and not yet made a
   * campaign got four tiles reading 0, 0, 0, 0 and two paragraphs explaining that nothing
   * had happened — the largest block on the page, spent on the absence of news.
   */
  live: boolean;
  /**
   * The empty state, for the single case the checklist cannot cover: a merchant who
   * finished it and has since deleted the campaigns they finished it with. Any other
   * empty shop is already being told what to do by the checklist itself.
   */
  emptyState: boolean;
  /**
   * Whether "Create campaign" is the black button.
   *
   * Only once the checklist has gone — while it is up, its own next step is what the page
   * is pointing at, and two black buttons point at nothing — and only when quick create
   * is not offered. Quick create *is* creating a campaign, for the case that covers most
   * of them, so when both are on the page it is the one worth pointing at and the full
   * editor becomes the alternative.
   */
  createIsPrimary: boolean;
  /**
   * The one-field card: a percentage, a button, a draft campaign.
   *
   * Needs a synced catalogue, because there is nothing to price without one, and needs
   * the checklist gone: a merchant three steps into being told what to do next does not
   * need a fourth thing to do offered beside it.
   */
  quickCreate: boolean;
  /** The catalogue card, which has nothing to count before a sync. */
  catalogue: boolean;
}

export function homeSections(facts: HomeFacts): HomeSections {
  // Something to report is a campaign that exists or a run that happened — not a set of
  // counters that all read zero.
  const live = facts.campaigns > 0 || facts.hasRun;

  const quickCreate = !facts.neverSynced && facts.onboardingComplete;

  return {
    live,
    emptyState: !facts.neverSynced && !live && facts.onboardingComplete,
    createIsPrimary: facts.onboardingComplete && !quickCreate,
    catalogue: !facts.neverSynced,
    quickCreate,
  };
}
