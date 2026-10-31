import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  ALL_STATES,
  canTransition,
  describeState,
  isTerminal,
  needsAttention,
  pricesMayBeLive,
  type CampaignState,
} from "./transitions";

const anyState = () => fc.constantFrom<CampaignState>(...ALL_STATES);

describe("legal transitions", () => {
  it("walks the documented happy path", () => {
    const path: CampaignState[] = [
      "DRAFT",
      "SCHEDULED",
      "APPLYING",
      "ACTIVE",
      "REVERTING",
      "COMPLETED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]}`).toBe(true);
    }
  });

  it("lets a partial run resume", () => {
    // The acceptance criterion this whole state exists for: a partial must be
    // recoverable, not a dead end.
    expect(canTransition("PARTIAL", "APPLYING")).toBe(true);
    expect(canTransition("PARTIAL", "REVERTING")).toBe(true);
  });

  it("lets a held campaign resolve either way", () => {
    expect(canTransition("HELD", "APPLYING")).toBe(true);
    expect(canTransition("HELD", "REVERTING")).toBe(true);
  });

  it("re-arms a completed campaign for the next occurrence", () => {
    // Recurrence reuses the campaign rather than cloning it, so the run history stays
    // in one place.
    expect(canTransition("COMPLETED", "SCHEDULED")).toBe(true);
  });

  it("treats cancelled as the only dead end", () => {
    expect(isTerminal("CANCELLED")).toBe(true);
    for (const state of ALL_STATES.filter((s) => s !== "CANCELLED")) {
      expect(isTerminal(state), state).toBe(false);
    }
  });

  it("refuses to resurrect a cancelled campaign", () => {
    for (const to of ALL_STATES.filter((s) => s !== "CANCELLED")) {
      expect(canTransition("CANCELLED", to), to).toBe(false);
    }
  });

  it("never skips straight from draft to active", () => {
    // Going ACTIVE without passing through APPLYING would mean claiming prices are
    // live and verified without ever having written any.
    expect(canTransition("DRAFT", "ACTIVE")).toBe(false);
    expect(canTransition("SCHEDULED", "ACTIVE")).toBe(false);
  });

  it("allows cancelling from anywhere that is still alive", () => {
    for (const state of ALL_STATES.filter((s) => s !== "CANCELLED")) {
      expect(canTransition(state, "CANCELLED"), state).toBe(true);
    }
  });

  it("is idempotent: any state may transition to itself", () => {
    // A redelivered tick asking for a state we already hold must be a no-op, not a
    // failure. Without this, every duplicate webhook or double tick raises an error.
    fc.assert(
      fc.property(anyState(), (state) => {
        expect(canTransition(state, state)).toBe(true);
      }),
    );
  });

  it("never throws, for any pair of states", () => {
    fc.assert(
      fc.property(anyState(), anyState(), (from, to) => {
        expect(() => canTransition(from, to)).not.toThrow();
        expect(typeof canTransition(from, to)).toBe("boolean");
      }),
    );
  });
});

describe("a held campaign with an end (#784)", () => {
  it("says the end still comes, and what it does with the edited prices", () => {
    const held = describeState("HELD", { heldUntil: "30 Nov 2026, 23:59 (America/New_York)" });
    expect(held.explanation).toContain("Its window still ends 30 Nov 2026, 23:59 (America/New_York)");
    expect(held.explanation).toContain("the edited ones stay as edited until you decide");
  });

  it("says nothing about an end it does not have", () => {
    expect(describeState("HELD").explanation).not.toContain("window");
  });
});

describe("what the merchant is told", () => {
  it("describes every state without falling through", () => {
    for (const state of ALL_STATES) {
      const described = describeState(state);
      expect(described.label, state).toBeTruthy();
      expect(described.explanation.length, state).toBeGreaterThan(20);
    }
  });

  it("gives the two attention states a way out", () => {
    // A partial with no resume, or a held with no link to the drift queue, is a dead
    // end dressed up as information.
    expect(describeState("PARTIAL").nextAction?.intent).toBe("resume");
    expect(describeState("HELD").nextAction?.intent).toBe("drift");
  });

  it("says which way a Resume goes (#702)", () => {
    // A partial revert resumed as an apply re-applied the sale; the button must name it.
    expect(describeState("PARTIAL", { resumes: "REVERT" }).nextAction?.label).toBe("Resume revert");
    expect(describeState("PARTIAL", { resumes: "APPLY" }).nextAction?.label).toBe("Resume apply");
    expect(describeState("PARTIAL", { resumes: "REVERT" }).explanation).toMatch(/finishes the revert/);
    expect(describeState("PARTIAL").nextAction?.label).toBe("Resume");
  });

  it("does not dress up partial or held as success", () => {
    expect(describeState("PARTIAL").tone).toBe("critical");
    expect(describeState("HELD").tone).toBe("warning");
    expect(needsAttention("PARTIAL")).toBe(true);
    expect(needsAttention("HELD")).toBe(true);
  });

  it("reserves success for the state where every row was verified", () => {
    const successes = ALL_STATES.filter((s) => describeState(s).tone === "success");
    expect(successes).toEqual(["ACTIVE"]);
  });

  it("knows where prices may still be live", () => {
    // Drives the "your prices are safe" wording on the error screen and the warning
    // before deleting a campaign.
    expect(pricesMayBeLive("PARTIAL")).toBe(true);
    expect(pricesMayBeLive("ACTIVE")).toBe(true);
    expect(pricesMayBeLive("HELD")).toBe(true);
    expect(pricesMayBeLive("DRAFT")).toBe(false);
    expect(pricesMayBeLive("COMPLETED")).toBe(false);
    expect(pricesMayBeLive("CANCELLED")).toBe(false);
  });
});

describe("a practice campaign's status (#759)", () => {
  it("does not promise a write when it is applied, because it never can be", () => {
    // Under a banner saying "nothing has been or will be written", the Status card said
    // "nothing will be until you apply it" -- of a campaign with no Apply.
    const practice = describeState("DRAFT", { practice: true });

    expect(practice.explanation).not.toMatch(/until you apply/);
    expect(practice.explanation).toContain("nothing ever will be");
    expect(practice.nextAction).toBeUndefined();
  });

  it("names the action that makes a real campaign of it (#1077)", () => {
    // Not "create a real campaign with the same scope and rule": the page has a button that
    // does exactly that, and the merchant was rebuilding the campaign by hand.
    expect(describeState("DRAFT", { practice: true }).explanation).toMatch(/Make a real copy/);
  });

  it("leaves a real draft's explanation and its Apply alone", () => {
    expect(describeState("DRAFT").explanation).toContain("until you apply it");
    expect(describeState("DRAFT", { practice: false }).nextAction?.intent).toBe("apply");
  });
});

describe("a scheduled campaign that will never start (#824)", () => {
  it("is not described as waiting, and says what to do", () => {
    const described = describeState("SCHEDULED", { neverStarts: "Its end is not after its start, so it will never be applied." });
    expect(described.label).toBe("Scheduled — will never start");
    expect(described.tone).toBe("warning");
    expect(described.explanation).toMatch(/Move its dates, or unschedule it/);
    expect(described.explanation).not.toMatch(/Waiting for its start time/);
  });

  it("is still waiting when it can start", () => {
    expect(describeState("SCHEDULED", { neverStarts: null }).explanation).toMatch(/Waiting for its start time/);
  });
});

describe("a Partial campaign's explanation follows what its run got done (#927)", () => {
  it("says prices were sent and not read back when none was verified", () => {
    const apply = describeState("PARTIAL", { resumes: "APPLY", progress: { confirmed: 0, unconfirmed: 4 } }).explanation;
    expect(apply).toMatch(/^Prices were sent to Shopify, but none has been read back yet, so none is verified/);
    expect(apply).not.toMatch(/were written and verified/);
    const revert = describeState("PARTIAL", { resumes: "REVERT", progress: { confirmed: 0, unconfirmed: 2 } }).explanation;
    expect(revert).toMatch(/^Prices were sent to Shopify to put back, but none has been read back yet/);
  });

  it("claims no price changed when nothing was written or sent", () => {
    const apply = describeState("PARTIAL", { resumes: "APPLY", progress: { confirmed: 0, unconfirmed: 0 } }).explanation;
    expect(apply).toMatch(/^It stopped before any price was written and verified/);
    expect(apply).not.toMatch(/Some prices|sent to Shopify/);
    const revert = describeState("PARTIAL", { resumes: "REVERT", progress: { confirmed: 0, unconfirmed: 0 } }).explanation;
    expect(revert).toMatch(/still be live/);
  });

  it("keeps the some-verified wording when some were, and when the counts are unknown", () => {
    for (const context of [{ progress: { confirmed: 3, unconfirmed: 1 } }, {}]) {
      expect(describeState("PARTIAL", { resumes: "APPLY", ...context }).explanation).toMatch(
        /^Some prices were written and verified; others were not/,
      );
    }
  });
});

describe("a Partial revert that kept edits says Resume leaves them alone (#1157)", () => {
  it("counts them, after what the revert got done", () => {
    const one = describeState("PARTIAL", { resumes: "REVERT", progress: { confirmed: 2, unconfirmed: 0 }, kept: 1 }).explanation;
    expect(one).toMatch(/^Some prices were put back and verified/);
    expect(one).toMatch(/Resuming finishes the revert\. 1 price edited outside Anchor that the revert kept stays as edited: Resume leaves it alone\.$/);
    const three = describeState("PARTIAL", { resumes: "REVERT", progress: { confirmed: 0, unconfirmed: 0 }, kept: 3 }).explanation;
    expect(three).toMatch(/3 prices edited outside Anchor that the revert kept stay as edited: Resume leaves them alone\.$/);
  });

  it("says nothing of edits when it kept none, or when the run it resumes is an apply", () => {
    const none = describeState("PARTIAL", { resumes: "REVERT", kept: 0 }).explanation;
    expect(none).toBe(describeState("PARTIAL", { resumes: "REVERT" }).explanation);
    expect(none).not.toMatch(/edited outside Anchor/);
    expect(describeState("PARTIAL", { resumes: "APPLY", kept: 2 }).explanation).not.toMatch(/edited outside Anchor/);
  });
});

describe("a Partial revert over a percentage only the merchant can clear says so above Resume (#1162)", () => {
  it("names each market, and what to do before resuming", () => {
    const one = describeState("PARTIAL", { resumes: "REVERT", progress: { confirmed: 0, unconfirmed: 0 }, clearByHand: ["Europe"] }).explanation;
    expect(one).toMatch(
      /Resuming finishes the revert\. Europe had no market-wide percentage of its own before this campaign, and the app cannot remove the one the campaign gave it\. Clear it in Shopify's Markets settings, then Resume the revert\.$/,
    );
    const three = describeState("PARTIAL", { resumes: "REVERT", clearByHand: ["Europe", "Japan", "Canada"] }).explanation;
    expect(three).toMatch(/Europe, Japan and Canada had no market-wide percentage of their own before this campaign, and the app cannot remove the ones the campaign gave them\./);
    expect(three).toMatch(/Clear each in Shopify's Markets settings, then Resume the revert\.$/);
  });

  it("says nothing of it when there is none, or when the run it resumes is an apply", () => {
    expect(describeState("PARTIAL", { resumes: "REVERT", clearByHand: [] }).explanation).toBe(describeState("PARTIAL", { resumes: "REVERT" }).explanation);
    expect(describeState("PARTIAL", { resumes: "APPLY", clearByHand: ["Europe"] }).explanation).not.toMatch(/Markets settings/);
  });
});

describe("an active campaign that a higher-priority one outranks everywhere (#837)", () => {
  it("does not claim the storefront shows its price, and names who does", () => {
    const described = describeState("ACTIVE", { outrankedBy: ["QA 687 high"] });
    expect(described.explanation).not.toContain("Your storefront shows the campaign price");
    expect(described.explanation).toContain("QA 687 high outranks it on every variant it covers");
    expect(described.explanation).toContain("takes over when it ends");
    expect(described.label, "still Active: it is running, and will price them").toBe("Active");
  });

  it("names several in one sentence", () => {
    expect(describeState("ACTIVE", { outrankedBy: ["Autumn", "Clearance", "VIP"] }).explanation).toContain(
      "Autumn, Clearance and VIP outrank it",
    );
  });

  it("says the storefront shows its price when nothing outranks it everywhere", () => {
    expect(describeState("ACTIVE", { outrankedBy: [] }).explanation).toContain("Your storefront shows the campaign price");
    expect(describeState("ACTIVE").explanation).toContain("Your storefront shows the campaign price");
  });
});

describe("an active campaign whose baseline was recaptured at its sale price (#781)", () => {
  it("does not read verified, needs a decision, and says what applying and reverting would do", () => {
    const described = describeState("ACTIVE", { recapturedAtSale: 1, outrankedBy: [] });
    expect(described.label).toBe("Active — needs a decision");
    expect(described.tone).toBe("warning");
    expect(described.explanation).not.toContain("verified");
    expect(described.explanation).toContain("the baseline of 1 of its variants was recaptured at the sale price");
    expect(described.explanation).toContain("Applying again would discount it a second time");
    expect(described.explanation).toContain("reverting would leave it at the sale price instead of the price before the campaign");
    expect(described.explanation).toContain("import it as the baseline on Prices → Baselines, then revert");
    expect(described.nextAction?.intent).toBe("revert");
  });

  it("counts several, grouped", () => {
    expect(describeState("ACTIVE", { recapturedAtSale: 3_673 }).explanation).toContain(
      "the baselines of 3,673 of its variants were recaptured",
    );
  });

  it("reads as before with none", () => {
    expect(describeState("ACTIVE", { recapturedAtSale: 0 }).label).toBe("Active");
    expect(describeState("ACTIVE", { recapturedAtSale: 0 }).explanation).toContain("every row was read back and verified");
  });
});

describe("a scheduled campaign whose start was refused for good (#975)", () => {
  const reason = "This campaign's segment was deleted, so it has no products to price.";

  it("says it couldn't start, why, that nothing was written, and what to do", () => {
    const described = describeState("SCHEDULED", { startRefused: reason });
    expect(described.label).toBe("Scheduled — couldn't start");
    expect(described.tone).toBe("warning");
    expect(described.explanation).toContain(reason);
    expect(described.explanation).toMatch(/Nothing was written/);
    expect(described.explanation).toMatch(/will not try this start again/);
    expect(described.explanation).toMatch(/apply it by hand, or move its dates under Schedule/);
    expect(described.explanation).not.toMatch(/Waiting for its start time/);
  });

  it("is said ahead of a window that has since closed, which is the less specific reason", () => {
    const described = describeState("SCHEDULED", { startRefused: reason, neverStarts: "Its window ended." });
    expect(described.label).toBe("Scheduled — couldn't start");
  });

  it("is still waiting when nothing was refused", () => {
    expect(describeState("SCHEDULED", { startRefused: null }).explanation).toMatch(/Waiting for its start time/);
  });
});

describe("a scheduled campaign past its start that has not started (#851)", () => {
  const reason = "This campaign is waiting for approval. staff:1 asked on 2026-10-15; somebody else needs to approve it.";

  it("names why, instead of waiting for a start time that has come", () => {
    const described = describeState("SCHEDULED", { lateStart: reason });
    expect(described.label).toBe("Scheduled — not started yet");
    expect(described.tone).toBe("warning");
    expect(described.explanation).toContain(reason);
    expect(described.explanation).not.toMatch(/Waiting for its start time/);
  });

  it("gives way to a refusal for good and to a window that can never open", () => {
    expect(describeState("SCHEDULED", { lateStart: reason, startRefused: "Its segment was deleted." }).label).toBe(
      "Scheduled — couldn't start",
    );
    expect(describeState("SCHEDULED", { lateStart: reason, neverStarts: "Its window ended." }).label).toBe(
      "Scheduled — will never start",
    );
  });

  it("is still waiting before its start", () => {
    expect(describeState("SCHEDULED", { lateStart: null }).label).toBe("Scheduled");
  });
});

describe("a scheduled campaign whose start needs a confirmation it does not have (#1009)", () => {
  const reason = "8 prices move more than 50% from their baseline. Nobody has confirmed it by typing “apply”.";

  it("says so before the start, and where to confirm it", () => {
    const described = describeState("SCHEDULED", { unconfirmedStart: reason });
    expect(described.label).toBe("Scheduled — needs confirming");
    expect(described.tone).toBe("warning");
    expect(described.explanation).toContain(reason);
    expect(described.explanation).toContain("Confirm it under “Scheduled and Flow starts” on the Overview tab.");
  });

  it("gives way to a refusal for good and to a window that can never open, and comes before a late start", () => {
    expect(describeState("SCHEDULED", { unconfirmedStart: reason, startRefused: "It grew." }).label).toBe("Scheduled — couldn't start");
    expect(describeState("SCHEDULED", { unconfirmedStart: reason, neverStarts: "Its window ended." }).label).toBe(
      "Scheduled — will never start",
    );
    expect(describeState("SCHEDULED", { unconfirmedStart: reason, lateStart: "Waiting for approval." }).label).toBe(
      "Scheduled — needs confirming",
    );
    expect(describeState("SCHEDULED", { unconfirmedStart: null }).label).toBe("Scheduled");
  });
});

describe("an active campaign whose scheduled end could not run (#1005)", () => {
  it("says its sale prices are still live past its end, why, and to revert by hand", () => {
    const described = describeState("ACTIVE", { endMissed: "Anchor couldn't reach its database." });
    expect(described.label).toBe("Active — past its end");
    expect(described.tone).toBe("critical");
    expect(described.explanation).toMatch(/still on your storefront: Anchor couldn't reach its database\./);
    expect(described.nextAction?.intent).toBe("revert");
  });

  it("reads as running when its end has not been missed", () => {
    expect(describeState("ACTIVE", { endMissed: null }).label).toBe("Active");
  });
});

describe("a campaign still applying when its revert was due (#829)", () => {
  it("says it is ending late, when its window ends, why the revert waits, and when it begins", () => {
    const described = describeState("APPLYING", { endingLate: "25 Sep 2026, 14:10 (America/New_York)" });
    expect(described.label).toBe("Applying — ending late");
    expect(described.tone).toBe("warning");
    expect(described.explanation).toMatch(/back by 25 Sep 2026, 14:10 \(America\/New_York\)\./);
    expect(described.explanation).toMatch(/One run writes a campaign's prices at a time/);
    expect(described.explanation).toMatch(/the revert begins as soon as the apply finishes/);
    expect(described.explanation).toMatch(/stay on your storefront, past its end/);
    // A revert cannot start under a running apply, so the card offers none.
    expect(described.nextAction).toBeUndefined();
  });

  it("reads as applying while it is on time", () => {
    expect(describeState("APPLYING", { endingLate: null }).label).toBe("Applying");
    expect(describeState("APPLYING").label).toBe("Applying");
  });
});

describe("a run waiting for its turn at Shopify (#1054)", () => {
  const waiting = 'Waiting behind "Spring sale", whose bulk price update is still running in Shopify.';

  it("says it is waiting, and behind whom, instead of writing prices now", () => {
    for (const [state, label] of [
      ["APPLYING", "Applying — waiting for Shopify"],
      ["REVERTING", "Reverting — waiting for Shopify"],
    ] as const) {
      const described = describeState(state, { waitingBehind: waiting });
      expect(described.label).toBe(label);
      expect(described.tone).toBe("info");
      expect(described.explanation).toBe(waiting);
    }
  });

  it("reads as writing when it is not waiting", () => {
    expect(describeState("APPLYING", { waitingBehind: null }).label).toBe("Applying");
    expect(describeState("REVERTING", { waitingBehind: null }).label).toBe("Reverting");
  });

  it("gives way to ending late, which is the warning", () => {
    expect(describeState("APPLYING", { waitingBehind: waiting, endingLate: "25 Sep 2026, 14:10 (UTC)" }).label).toBe(
      "Applying — ending late",
    );
  });
});
