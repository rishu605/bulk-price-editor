import { describe, expect, it } from "vitest";

import { money } from "../money/money";
import { blockedMessage, type BlockedLine } from "./blocked-message";

const usd = (amount: number) => money(amount, "USD");
const gloves: BlockedLine = { title: "Cascade Gloves 44 · L", reason: "below-floor", wouldBe: usd(33), floor: usd(1_000) };

describe("a campaign a blocking guardrail stops, in words (#1076)", () => {
  it("names the variant, its price and its floor, and what to do", () => {
    expect(blockedMessage([gloves], "run")).toBe(
      'A guardrail stopped this run before anything was written: "Cascade Gloves 44 · L" would be $0.33, under its $10.00 floor. ' +
        'Lower the floor in Settings, take this variant out of the campaign\'s products, or set "When a price would breach a floor" ' +
        "to clamp or skip instead of blocking.",
    );
  });

  it("speaks of a preview in the future", () => {
    expect(blockedMessage([gloves], "preview")).toMatch(/^A guardrail set to block the whole campaign would stop it before anything is written: /);
  });

  it("names five and counts the rest", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...gloves, title: `Variant ${i + 1}` }));
    const text = blockedMessage(many, "run");
    expect(text).toContain('"Variant 5" would be $0.33');
    expect(text).not.toContain('"Variant 6"');
    expect(text).toContain("; and 3 more.");
    expect(text).toContain("take these 8 variants out of the campaign's products");
  });

  it("says a reason with no floor in words, and asks for the costs a cost floor needs", () => {
    const text = blockedMessage([{ title: "Socks", reason: "missing-cost" }], "run");
    expect(text).toContain('"Socks": no cost recorded.');
    expect(text).toContain(", record the missing costs,");
    expect(text).not.toContain("missing-cost");
  });
});
