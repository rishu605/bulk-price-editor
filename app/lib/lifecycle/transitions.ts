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

import type { QueuedRefusal } from "../campaigns/queued-refusal";

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
export const PRICES_MAY_BE_LIVE: ReadonlySet<CampaignState> = new Set<CampaignState>([
  "APPLYING",
  "ACTIVE",
  "HELD",
  "REVERTING",
  "PARTIAL",
]);

/**
 * States whose campaign is meant to be pricing its variants, so every other campaign
 * resolves against it (#821).
 *
 * Overlap counted ACTIVE alone. A campaign held by one hand edit -- routine -- still has
 * its sale live, yet a lower-priority campaign planned as if it were not there, wrote over
 * it, and reverting that one wrote baselines under it.
 *
 * `PRICES_MAY_BE_LIVE` without REVERTING: a campaign being ended may still have prices up,
 * but it must not win a variant from anyone, or another campaign's revert would write its
 * sale back (#805). A Partial campaign stopped part-way through a revert is being ended
 * too; telling that apart needs its run history, which `competingCampaigns` reads.
 */
export const PRICING_STATES: ReadonlySet<CampaignState> = new Set<CampaignState>([
  "APPLYING",
  "ACTIVE",
  "HELD",
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

/**
 * The tone of each state's badge, wherever a campaign's state is drawn (#1016).
 *
 * One map. The calendar and Home's upcoming list had their own, which agreed with this
 * one until they did not: a Partial campaign was critical in the list and on its own page,
 * and warning on the calendar beside it. Partial is critical because some of its rows did
 * not complete, which is the failure this product exists to make visible.
 *
 * `describeState` starts from this and departs from it only where what it knows changes
 * the answer: a scheduled campaign that cannot start, an active one past its end.
 */
export const STATE_TONE: Readonly<Record<CampaignState, StateTone>> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  APPLYING: "info",
  ACTIVE: "success",
  HELD: "warning",
  REVERTING: "info",
  COMPLETED: "info",
  PARTIAL: "critical",
  CANCELLED: "neutral",
};

export interface StateDescription {
  label: string;
  tone: StateTone;
  /** What this state actually means for the merchant's storefront, in plain words. */
  explanation: string;
  /** The one thing worth doing next, if there is one. */
  nextAction?: { label: string; intent: "resume" | "revert" | "apply" | "drift" };
}

export function describeState(
  state: CampaignState,
  /**
   * Which kind of run a Resume would continue: the one that left the campaign PARTIAL. A
   * partial revert resumes as a revert, and the button has to say so (#702).
   */
  context: {
    resumes?: "APPLY" | "REVERT";
    /** When a held campaign's window ends, as the page writes it (#784). */
    heldUntil?: string;
    /** Why a scheduled campaign will never start on its own (#824); see `neverStarts`. */
    neverStarts?: string | null;
    /**
     * What the run that left it Partial got done (#927): rows written and read back
     * (`confirmed`, clamped ones included), and rows written or sent to Shopify that no
     * read-back has confirmed (`unconfirmed`). Without it the banner said "some prices were
     * written and verified" over a bulk run that had verified none.
     */
    progress?: { confirmed: number; unconfirmed: number };
    /**
     * The campaigns pricing every variant an active campaign covers, when it prices none
     * itself (#837): the preview's `outrankedBy`. Empty or absent otherwise.
     */
    outrankedBy?: readonly string[];
    /** Why its start was refused for good, so the schedule left it (#975); see `startRefusal`. */
    startRefused?: string | null;
    /** Why a scheduled campaign past its start has not started yet (#851); see `lateStart`. */
    lateStart?: string | null;
    /** Why its scheduled end has not run, while the scheduler keeps trying (#1005); see `endMissed`. */
    endMissed?: string | null;
    /**
     * Why its start, as the campaign is now, needs a typed confirmation it does not have
     * (#1009); see `unconfirmedStart`. The scheduler will refuse it when it comes.
     */
    unconfirmedStart?: string | null;
    /**
     * When the window ends, for a campaign still applying past the moment its revert was due
     * (#829); see `endingLateText`.
     */
    endingLate?: string | null;
    /**
     * When the window opened, for a scheduled campaign still applying well after it (#1056);
     * see `startingLateText`.
     */
    startingLate?: string | null;
    /** A run handed to the background worker and refused before it wrote (#1046); see `queuedRefusal`. */
    queuedRefused?: QueuedRefusal | null;
    /**
     * A practice campaign, which is never applied (#759): its draft explanation may not
     * promise a write "until you apply it" under a banner saying nothing ever will be.
     */
    practice?: boolean;
    /**
     * Why its run has written nothing yet: Shopify is running as many bulk updates for this
     * store as it allows, and the run is waiting for a turn (#1054); see `bulkWaitOf`.
     */
    waitingBehind?: string | null;
  } = {},
): StateDescription {
  // Said over whatever state the refusal left it in, until a later run claims it (#1046): the
  // merchant was told the worker had it, and Flow's run log says "queued". Not while a run
  // holds the claim, which is that later run.
  if (context.queuedRefused && state !== "APPLYING" && state !== "REVERTING") {
    const base = describeState(state, { ...context, queuedRefused: null });
    const { verb, reason } = context.queuedRefused;
    return {
      ...base,
      label: `${base.label.split(" — ")[0]} — couldn't ${verb}`,
      tone: base.tone === "critical" ? "critical" : "warning",
      explanation: `Its ${verb} was handed to the background worker and could not run: ${reason} It wrote nothing. ${base.explanation}`,
    };
  }
  switch (state) {
    case "DRAFT":
      if (context.practice) {
        return {
          label: "Draft",
          tone: STATE_TONE.DRAFT,
          explanation:
            "A practice campaign. Nothing has been written to your storefront, and nothing ever will be: a practice campaign is never applied.",
        };
      }
      return {
        label: "Draft",
        tone: STATE_TONE.DRAFT,
        explanation:
          "Not running. Nothing has been written to your storefront, and nothing will be until you apply it.",
        nextAction: { label: "Apply to storefront", intent: "apply" },
      };
    case "SCHEDULED":
      // Refused when it came due, for a reason asking again cannot change (#975). Said here
      // rather than once per tick in its history, with what to do: the schedule does not
      // try this start again, so waiting changes nothing.
      if (context.startRefused) {
        return {
          label: "Scheduled — couldn't start",
          tone: "warning",
          explanation:
            `Its start came, and it could not be run: ${context.startRefused} Nothing was written to your ` +
            "storefront, and the schedule will not try this start again. Once that is fixed, apply it by " +
            "hand, or move its dates under Schedule.",
        };
      }
      // Not "waiting" when there is nothing to wait for (#824): a window that can never
      // open is a decision for the merchant, so it says so and says what to do.
      if (context.neverStarts) {
        return {
          label: "Scheduled — will never start",
          tone: "warning",
          explanation: `${context.neverStarts} Move its dates, or unschedule it, under Schedule.`,
        };
      }
      // Said before its start comes, not only after the scheduler refuses it (#1009): a sale
      // scheduled before the start check existed, or one that has grown since it was
      // confirmed, is refused at its start unless somebody confirms it first.
      if (context.unconfirmedStart) {
        return {
          label: "Scheduled — needs confirming",
          tone: "warning",
          explanation:
            `${context.unconfirmedStart} The schedule starts it with nobody there to type “apply”, so it will not ` +
            "start it until it is confirmed. Confirm it under “Scheduled and Flow starts” on the Overview tab.",
        };
      }
      // Past its start and not started (#851): not "waiting for its start time", which has
      // come. The reason is the scheduler's own, and it carries what to do about it.
      if (context.lateStart) {
        return {
          label: "Scheduled — not started yet",
          tone: "warning",
          explanation:
            `Its start time has passed, and it has not started: ${context.lateStart} ` +
            "The scheduler tries again every 30 seconds, so it starts on its own once that is resolved.",
        };
      }
      return {
        label: "Scheduled",
        tone: STATE_TONE.SCHEDULED,
        explanation:
          "Waiting for its start time. Prices change automatically when the window opens.",
      };
    case "APPLYING":
      // Its end came while it was still applying (#829). The revert cannot start under a
      // running apply, so the sale outlives its window; said, rather than "Applying" as if
      // nothing were wrong.
      if (context.endingLate) {
        return {
          label: "Applying — ending late",
          tone: "warning",
          explanation:
            `It is still applying its prices, and its revert was due to begin so they would be back by ${context.endingLate}. ` +
            "One run writes a campaign's prices at a time, so the revert begins as soon as the apply finishes. Until then the " +
            "sale's prices stay on your storefront, past its end.",
        };
      }
      // Not "Writing prices now" while it is not allowed to (#1054).
      if (context.waitingBehind) {
        return { label: "Applying — waiting for Shopify", tone: STATE_TONE.APPLYING, explanation: context.waitingBehind };
      }
      // Its start came a while ago and its prices are still being written (#1056): the sale
      // reaches the storefront product by product, later than the window says.
      if (context.startingLate) {
        return {
          label: "Applying — starting late",
          tone: "warning",
          explanation:
            `Its window opened at ${context.startingLate}, and its prices are still being written, so the sale is ` +
            "reaching your storefront late: each product shows its sale price as it is written and read back.",
        };
      }
      return {
        label: "Applying",
        tone: STATE_TONE.APPLYING,
        explanation: "Writing prices now. The ledger fills in as each row is verified.",
      };
    case "ACTIVE":
      // Past its end with its sale prices still live (#1005): not "running" as planned.
      if (context.endMissed) {
        return {
          label: "Active — past its end",
          tone: "critical",
          explanation:
            `Its window has ended, but its revert could not run, so its sale prices are still on your storefront: ${context.endMissed} ` +
            "The schedule keeps trying. To end the sale now, revert it by hand.",
          nextAction: { label: "Revert", intent: "revert" },
        };
      }
      return {
        label: "Active",
        tone: STATE_TONE.ACTIVE,
        // Not while a higher-priority campaign prices every variant this one covers (#837):
        // the storefront shows that campaign's price, and this one's takes over when it ends.
        explanation: context.outrankedBy?.length
          ? outranked(context.outrankedBy)
          : "Running, and every row was read back and verified. Your storefront shows the campaign price.",
        nextAction: { label: "Revert", intent: "revert" },
      };
    case "HELD":
      return {
        label: "Held — price edited outside Anchor",
        tone: STATE_TONE.HELD,
        explanation:
          "Someone changed a price this campaign controls, so the campaign stopped writing rather than overwrite a deliberate decision. Nothing has been lost; choose what should win." +
          // The end still comes while it is held (#784), and the merchant should know what
          // it will do: everything else goes back on time, the edited prices stay.
          (context.heldUntil
            ? ` Its window still ends ${context.heldUntil}: then every other price reverts on schedule, and the edited ones stay as edited until you decide.`
            : ""),
        nextAction: { label: "Review the drift queue", intent: "drift" },
      };
    case "REVERTING":
      if (context.waitingBehind) {
        return { label: "Reverting — waiting for Shopify", tone: STATE_TONE.REVERTING, explanation: context.waitingBehind };
      }
      return {
        label: "Reverting",
        tone: STATE_TONE.REVERTING,
        explanation:
          "Recomputing each price without this campaign. Variants another campaign still covers keep that campaign's price.",
      };
    case "PARTIAL":
      return {
        label: "Partial — some rows did not complete",
        tone: STATE_TONE.PARTIAL,
        explanation: partialExplanation(context.resumes === "REVERT", context.progress),
        nextAction: {
          label:
            context.resumes === "REVERT"
              ? "Resume revert"
              : context.resumes === "APPLY"
                ? "Resume apply"
                : "Resume",
          intent: "resume",
        },
      };
    case "COMPLETED":
      return {
        label: "Completed",
        tone: STATE_TONE.COMPLETED,
        explanation:
          "Finished and reverted. Prices are back to what they would be without this campaign.",
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        tone: STATE_TONE.CANCELLED,
        explanation: "Stopped and will not run again.",
      };
  }
}

/**
 * What a Partial campaign's banner says happened, from what its last run actually got
 * done (#927). "Some were verified" only when some were: a bulk run stopped after Shopify
 * accepted it has verified nothing yet, and one stopped before its first write changed
 * nothing anyone has confirmed.
 */
function partialExplanation(reverting: boolean, progress?: { confirmed: number; unconfirmed: number }): string {
  if (progress && progress.confirmed === 0 && progress.unconfirmed > 0) {
    return reverting
      ? "Prices were sent to Shopify to put back, but none has been read back yet, so none is verified and parts of the sale may still be live. The ledger names every row. Resuming checks what landed and finishes the revert."
      : "Prices were sent to Shopify, but none has been read back yet, so none is verified and some may already be live. The ledger names every row. Resuming checks what landed and retries only what is outstanding.";
  }
  if (progress && progress.confirmed === 0) {
    return reverting
      ? "It stopped before any price was put back and verified, so expect the sale's prices to still be live. The ledger names every row and why it stopped. Resuming finishes the revert."
      : "It stopped before any price was written and verified. The ledger names every row and why it stopped. Resuming retries them.";
  }
  return reverting
    ? "Some prices were put back and verified; others were not, so parts of the sale may still be live. The ledger names every row and why it stopped. Resuming finishes the revert."
    : "Some prices were written and verified; others were not. The ledger names every row and why it stopped. Resuming retries only what is outstanding — rows already correct are left alone.";
}

/**
 * An active campaign's status line when other campaigns price every variant it covers (#837),
 * naming them: "A", "A and B", "A, B and C".
 */
function outranked(names: readonly string[]): string {
  const one = names.length === 1;
  const who = one ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return (
    `Running, but ${who} ${one ? "outranks" : "outrank"} it on every variant it covers, so your ` +
    `storefront shows ${one ? "that campaign's" : "their"} price. This campaign's price takes over ` +
    `when ${one ? "it ends" : "they end"}.`
  );
}

/** Every state, for exhaustive iteration in tests and pickers. */
export const ALL_STATES: readonly CampaignState[] = Object.keys(LEGAL) as CampaignState[];
