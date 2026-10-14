/**
 * The typed confirmation is a server check, not a modal.
 *
 * A-3.11 asks a merchant to type the word before a campaign over the blast-radius
 * threshold runs. #446 put that in the confirmation modal, which is where a merchant
 * meets it — and a modal can be dismissed, a field can be removed, and the same form can
 * be posted from anywhere. A confirmation that exists only in the browser is a
 * confirmation for merchants who use the browser the way we expected.
 *
 * The exemption matters as much as the check: reverting is the way *back*, and friction
 * between a merchant and undo is on the wrong side of the door.
 */

import { describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the factory cannot close over a `const`
// declared here — `vi.hoisted` is the way to share one spy with it.
const { previewCampaign, findCampaign } = vi.hoisted(() => ({
  previewCampaign: vi.fn(),
  findCampaign: vi.fn(async () => ({ status: "DRAFT" }) as { status: string } | null),
}));
vi.mock("./preview.server", () => ({ previewCampaign }));
vi.mock("../../db.server", () => ({ default: { campaign: { findFirst: findCampaign } } }));

import { blastRadiusRefusal, pressRefusal } from "./blast-radius.server";

/** 95% off three prices: under every count, over the change threshold. */
const deep = {
  thresholds: { variants: 1_000, changePercent: 50 },
  planned: 3,
  largeChanges: 3,
  largest: { title: "Wool coat", before: "$249.99", after: "$12.50", basisPoints: 9_499, direction: "down" as const },
  atMinimum: 0,
};

const preview = (over: Record<string, unknown> = {}) => ({
  counts: { planned: 5000, noop: 0, skipped: 0, clamped: 0 },
  blastRadius: true,
  ...over,
});

describe("over the threshold", () => {
  it("refuses without the word, and says how many prices are at stake", async () => {
    previewCampaign.mockResolvedValueOnce(preview());

    const refusal = await blastRadiusRefusal("shop", "c1", "");

    expect(refusal).toContain("5,000");
    expect(refusal).toContain("apply");
  });

  it("accepts the word however it was typed", async () => {
    // A merchant who types "Apply" has confirmed. Case is not the point of the check.
    for (const typed of ["apply", "APPLY", " Apply "]) {
      expect(await blastRadiusRefusal("shop", "c1", typed)).toBeNull();
    }
  });

  it("refuses a near miss rather than guessing", async () => {
    previewCampaign.mockResolvedValueOnce(preview());

    expect(await blastRadiusRefusal("shop", "c1", "appl")).not.toBeNull();
  });
});

describe("under the threshold", () => {
  it("asks for nothing", async () => {
    // Asking every time is how a confirmation becomes a reflex, and then it is not read
    // on the run that needed it.
    previewCampaign.mockResolvedValueOnce(preview({ blastRadius: false }));

    expect(await blastRadiusRefusal("shop", "c1", "")).toBeNull();
  });
});

describe("what it reads", () => {
  it("re-previews rather than trusting a count from the form", async () => {
    // The number a merchant was shown is not necessarily the number that would be
    // written now — the catalogue moves, and so does every other campaign on it.
    previewCampaign.mockResolvedValueOnce(preview());
    await blastRadiusRefusal("shop", "c1", "");

    expect(previewCampaign).toHaveBeenCalledWith("shop", "c1");
  });
});

describe("asked without a plan where it can be (#803)", () => {
  it("does not plan the campaign to check a word that was typed", async () => {
    previewCampaign.mockClear();
    expect(await blastRadiusRefusal("shop", "c1", "apply")).toBeNull();
    expect(previewCampaign, "a full plan ran to check the word 'apply'").not.toHaveBeenCalled();
  });

  it("plans a small scope too, since how far each price moves is only in the plan (#818)", async () => {
    // #803 let a scope at or under 1,000 through on a count. 95% off three variants is
    // under it, and is exactly the campaign the word is for.
    previewCampaign.mockClear();
    previewCampaign.mockResolvedValueOnce(
      preview({ counts: { planned: 3, noop: 0, skipped: 0, clamped: 0 }, confirm: deep }),
    );
    expect(await blastRadiusRefusal("shop", "c1", "")).toContain("3 prices move more than 50%");
    expect(previewCampaign).toHaveBeenCalledTimes(1);
  });

  it("still plans a large scope with nothing typed, since only the plan knows what it writes", async () => {
    previewCampaign.mockClear();
    previewCampaign.mockResolvedValueOnce(preview());
    expect(await blastRadiusRefusal("shop", "c1", "")).toContain("5,000");
    expect(previewCampaign).toHaveBeenCalledTimes(1);
  });
});

describe("refused for the reasons the dialog gave (#818)", () => {
  it("says each reason in the dialog's sentences, then what to type", async () => {
    previewCampaign.mockResolvedValueOnce(preview({ confirm: { ...deep, planned: 5_000, atMinimum: 12 } }));

    const refusal = await blastRadiusRefusal("shop", "c1", "");

    expect(refusal).toBe(
      "This campaign writes 5,000 prices, more than the 1,000 your settings allow without a typed confirmation. " +
        "3 prices move more than 50% from their baseline, or land that far below cost; the largest is " +
        "\u201CWool coat\u201D, down 95%. 12 prices would reach zero or below, and would be written at the " +
        "smallest price instead. Type \u201Capply\u201D in the confirmation box to run it.",
    );
  });

  it("names no price, only counts, percentages and a title", async () => {
    previewCampaign.mockResolvedValueOnce(preview({ confirm: deep }));
    expect(await blastRadiusRefusal("shop", "c1", "")).not.toMatch(/\$|249\.99|12\.50/);
  });

  it("asks nothing of a preview that does not ask, whatever its reasons hold", async () => {
    previewCampaign.mockResolvedValueOnce(preview({ blastRadius: false, confirm: { ...deep, largeChanges: 0, largest: null } }));
    expect(await blastRadiusRefusal("shop", "c1", "")).toBeNull();
  });
});

describe("which presses are asked (#720)", () => {
  it("asks Apply, and Resume on anything but a run that stopped part-way", async () => {
    for (const status of ["DRAFT", "SCHEDULED", "ACTIVE"]) {
      findCampaign.mockResolvedValueOnce({ status });
      previewCampaign.mockResolvedValueOnce(preview());
      expect(await pressRefusal("shop", "c1", "resume", ""), `a "resume" of a ${status} campaign`).toContain("apply");
    }
    previewCampaign.mockResolvedValueOnce(preview());
    expect(await pressRefusal("shop", "c1", "apply", "")).toContain("apply");
  });

  it("does not ask Resume to finish a run that stopped part-way, whose button has no box to type in", async () => {
    findCampaign.mockResolvedValueOnce({ status: "PARTIAL" });
    previewCampaign.mockClear();
    expect(await pressRefusal("shop", "c1", "resume", "")).toBeNull();
    expect(previewCampaign).not.toHaveBeenCalled();
  });

  it("does not ask anything else", async () => {
    // Reverting is the way back: see the top of this file.
    for (const intent of ["revert", "revert-variant", "archive"]) {
      expect(await pressRefusal("shop", "c1", intent, "")).toBeNull();
    }
  });
});
