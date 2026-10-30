/**
 * The Status card is told when a campaign is practice (#759).
 *
 * `describeState` can only branch on what it is handed, and this is what the campaign page
 * hands it. A draft needs no database read here, so none is mocked beyond the client.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../db.server", () => ({ default: {} }));

import { describeState } from "../../lib/lifecycle/transitions";
import { lifecycleContext } from "./lifecycle-context.server";

describe("a practice draft's Status card", () => {
  it("says nothing will ever be written, rather than until it is applied", async () => {
    const context = await lifecycleContext("shop", "c1", "DRAFT", { schedule: { kind: "manual" }, practice: true }, "UTC", {});

    expect(context.practice).toBe(true);
    expect(describeState("DRAFT", context).explanation).not.toMatch(/until you apply/);
  });

  it("goes by the practice column alone, not by a copy left in the schedule JSON (#1141)", async () => {
    // #884's release wrote the flag into the blob as well; nothing reads it there now.
    const staleCopy = { schedule: { kind: "manual", practice: true }, practice: false };
    const context = await lifecycleContext("shop", "c1", "DRAFT", staleCopy, "UTC", {});

    expect(context.practice).toBe(false);
  });

  it("keeps a real draft's Apply", async () => {
    const context = await lifecycleContext("shop", "c1", "DRAFT", { schedule: { kind: "manual" }, practice: false }, "UTC", {});

    expect(context.practice).toBe(false);
    expect(describeState("DRAFT", context).nextAction?.intent).toBe("apply");
  });
});
