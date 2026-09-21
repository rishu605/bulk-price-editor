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
  /**
   * The four figures the live section renders, by name.
   *
   * It used to take `campaigns` — every campaign in any state — and that is what made a
   * draft turn the section on. These are the tiles themselves, so "is there anything to
   * report" and "what does the section say" cannot disagree.
   */
  running: number;
  scheduled: number;
  needsAttention: number;
  driftOpen: number;
  /** Campaigns a merchant made and has not applied. Nothing of theirs is live. */
  drafts: number;
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
   *
   * The guard that replaced it was `campaigns > 0 || hasRun`, and `campaigns` counts
   * **drafts**. So the four zeroes came straight back for every shop that made one —
   * which is every shop that follows the product's own advice, since quick create says
   * "Creates a draft" and the editor's primary button is "Create and preview". The page
   * showed four zeroes *and* did not mention the draft that had turned them on.
   *
   * It is the tiles themselves now: the section appears when one of them would read
   * above zero, or when a run has happened. A section that claims to say what is live
   * cannot be switched on by something that is not.
   */
  live: boolean;
  /**
   * The draft line, for a shop whose only campaigns are ones it has not applied.
   *
   * Not a tile among the four. A draft is not a small amount of live — it is the thing
   * the merchant left half-done, and the answer to "what now" on a page that would
   * otherwise say nothing.
   */
  drafts: boolean;
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
  // Something to report is a tile that would read above zero, or a run that happened —
  // not a set of counters that all read zero. Adding them rather than testing each is
  // deliberate: the list here and the list the section renders are the same four.
  const counted =
    facts.running + facts.scheduled + facts.needsAttention + facts.driftOpen;
  const live = counted > 0 || facts.hasRun;

  const drafts = !live && facts.drafts > 0;

  const quickCreate = !facts.neverSynced && facts.onboardingComplete;

  return {
    live,
    drafts,
    // Nothing live and no draft either. A shop with a draft is told about the draft,
    // which answers the same question better than "nothing is running" does.
    emptyState: !facts.neverSynced && !live && !drafts && facts.onboardingComplete,
    createIsPrimary: facts.onboardingComplete && !quickCreate,
    catalogue: !facts.neverSynced,
    quickCreate,
  };
}
