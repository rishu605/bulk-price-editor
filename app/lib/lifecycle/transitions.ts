/**
 * The campaign state machine.
 *
 *   draft → scheduled → applying → active → reverting → completed
 *                          ↓                   ↓
 *                       partial ←──────────── partial
 *                          ↓
 *                        held (drift)
 *
 * Two states carry the product's whole trust proposition, and both are ones
 * competitors hide:
 *
 *   `partial` means some rows were written and some were not. It is not an
 *   embarrassment to be styled away -- it is the honest answer, and it comes with
 *   per-row reasons and a resume that works.
 *
 *   `held` means a merchant edited a price under a running campaign. Nothing is
 *   overwritten while held, because silently reasserting our price would destroy
 *   a deliberate human decision.
 *
 * Self-transitions are legal on purpose. A duplicate scheduler tick asking for
 * APPLYING while already APPLYING must be a no-op rather than an error, or every
 * redelivery becomes a spurious failure (acceptance: idempotent under duplicate
 * delivery).
 */

export type CampaignState =
  | "DRAFT"
  | "SCHEDULED"
  | "APPLYING"
  | "ACTIVE"
  | "HELD"
  | "REVERTING"
  | "COMPLETED"
  | "PARTIAL"
  | "CANCELLED";

/**
 * Where each state may legally go.
 *
 * COMPLETED → SCHEDULED exists for recurrence: a finished occurrence re-arms for the
 * next one rather than creating a second campaign. CANCELLED is the only truly
 * terminal state -- everything else can still be acted on.
 */
const LEGAL: Record<CampaignState, readonly CampaignState[]> = {
  DRAFT: ["SCHEDULED", "APPLYING", "CANCELLED"],
  SCHEDULED: ["APPLYING", "DRAFT", "CANCELLED"],
  // A run that finishes with every row verified goes ACTIVE; one with failures goes
  // PARTIAL. COMPLETED is reachable directly when a campaign's window closed while it
  // was still applying and there is nothing live to revert.
  APPLYING: ["ACTIVE", "PARTIAL", "HELD", "COMPLETED", "CANCELLED"],
  ACTIVE: ["REVERTING", "HELD", "PARTIAL", "APPLYING", "COMPLETED", "CANCELLED"],
  // Held resolves when the merchant decides: adopt their price, or re-apply ours.
  HELD: ["ACTIVE", "APPLYING", "REVERTING", "PARTIAL", "CANCELLED"],
  REVERTING: ["COMPLETED", "PARTIAL", "CANCELLED"],
  // Resume re-enters APPLYING; reverting a partial is also allowed, because prices
  // may well be live for the rows that did succeed.
  PARTIAL: ["APPLYING", "REVERTING", "ACTIVE", "COMPLETED", "HELD", "CANCELLED"],
  COMPLETED: ["SCHEDULED", "APPLYING", "CANCELLED"],
  CANCELLED: [],
};

/** States where prices this campaign wrote may be live on the storefront. */
const PRICES_MAY_BE_LIVE: ReadonlySet<CampaignState> = new Set<CampaignState>([
  "APPLYING",
  "ACTIVE",
  "HELD",
  "REVERTING",
  "PARTIAL",
]);

export function canTransition(from: CampaignState, to: CampaignState): boolean {
  // Idempotence: asking for the state you are already in always succeeds and changes
  // nothing. See the note at the top about duplicate ticks.
  if (from === to) return true;
  return LEGAL[from].includes(to);
}

/** Only CANCELLED is final. Everything else can still be resumed, reverted or re-armed. */
export function isTerminal(state: CampaignState): boolean {
  return LEGAL[state].length === 0;
}

/**
 * States the merchant has to do something about.
 *
 * Used to sort these to the top of the campaign list. A partial run that nobody
 * notices is indistinguishable from a successful one, which is the failure this
 * product exists to prevent.
 */
export function needsAttention(state: CampaignState): boolean {
  return state === "PARTIAL" || state === "HELD";
}

export function pricesMayBeLive(state: CampaignState): boolean {
  return PRICES_MAY_BE_LIVE.has(state);
}

export type StateTone = "info" | "success" | "critical" | "neutral" | "warning";

export interface StateDescription {
  label: string;
  tone: StateTone;
  /** What this state actually means for the merchant's storefront, in plain words. */
  explanation: string;
  /** The one thing worth doing next, if there is one. */
  nextAction?: { label: string; intent: "resume" | "revert" | "apply" | "drift" };
}

export function describeState(state: CampaignState): StateDescription {
  switch (state) {
    case "DRAFT":
      return {
        label: "Draft",
        tone: "neutral",
        explanation:
          "Not running. Nothing has been written to your storefront, and nothing will be until you apply it.",
        nextAction: { label: "Apply to storefront", intent: "apply" },
      };
    case "SCHEDULED":
      return {
        label: "Scheduled",
        tone: "info",
        explanation:
          "Waiting for its start time. Prices change automatically when the window opens.",
      };
    case "APPLYING":
      return {
        label: "Applying",
        tone: "info",
        explanation: "Writing prices now. The ledger fills in as each row is verified.",
      };
    case "ACTIVE":
      return {
        label: "Active",
        tone: "success",
        explanation:
          "Running, and every row was read back and verified. Your storefront shows the campaign price.",
        nextAction: { label: "Revert", intent: "revert" },
      };
    case "HELD":
      return {
        label: "Held — price edited outside Anchor",
        tone: "warning",
        explanation:
          "Someone changed a price this campaign controls, so the campaign stopped writing rather than overwrite a deliberate decision. Nothing has been lost; choose what should win.",
        nextAction: { label: "Review the drift queue", intent: "drift" },
      };
    case "REVERTING":
      return {
        label: "Reverting",
        tone: "info",
        explanation:
          "Recomputing each price without this campaign. Variants another campaign still covers keep that campaign's price.",
      };
    case "PARTIAL":
      return {
        label: "Partial — some rows did not complete",
        tone: "critical",
        explanation:
          "Some prices were written and verified; others were not. The ledger names every row and why it stopped. Resuming retries only what is outstanding — rows already correct are left alone.",
        nextAction: { label: "Resume", intent: "resume" },
      };
    case "COMPLETED":
      return {
        label: "Completed",
        tone: "info",
        explanation:
          "Finished and reverted. Prices are back to what they would be without this campaign.",
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        tone: "neutral",
        explanation: "Stopped and will not run again.",
      };
  }
}

/** Every state, for exhaustive iteration in tests and pickers. */
export const ALL_STATES: readonly CampaignState[] = Object.keys(LEGAL) as CampaignState[];
