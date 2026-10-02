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
const { previewCampaign, scopeSize } = vi.hoisted(() => ({ previewCampaign: vi.fn(), scopeSize: vi.fn(async () => 5_000) }));
vi.mock("./preview.server", () => ({ previewCampaign }));
vi.mock("./scope-size.server", () => ({ scopeSize }));

import { blastRadiusRefusal } from "./blast-radius.server";

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

  it("does not plan a scope too small to cross the threshold", async () => {
    previewCampaign.mockClear();
    scopeSize.mockResolvedValueOnce(1_000);
    expect(await blastRadiusRefusal("shop", "c1", "")).toBeNull();
    expect(previewCampaign).not.toHaveBeenCalled();
  });

  it("still plans a large scope with nothing typed, since only the plan knows what it writes", async () => {
    previewCampaign.mockClear();
    previewCampaign.mockResolvedValueOnce(preview());
    expect(await blastRadiusRefusal("shop", "c1", "")).toContain("5,000");
    expect(previewCampaign).toHaveBeenCalledTimes(1);
  });
});
