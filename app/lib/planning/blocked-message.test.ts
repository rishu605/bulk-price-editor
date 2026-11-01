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

describe("what a campaign that has started under Block is told to do (#1161)", () => {
  const SETTING = 'or set "When a price would breach a floor" to clamp or skip instead of blocking.';

  it("is told it keeps Block, and to lower the floor or start again under the store's policy now", () => {
    // The live case: Block kept from its start, and the store's setting changed to Clamp since.
    expect(blockedMessage([gloves], "run", { policy: "block", kept: true, store: "clamp" })).toBe(
      'A guardrail stopped this run before anything was written: "Cascade Gloves 44 · L" would be $0.33, under its $10.00 floor. ' +
        'This campaign started under "Block the whole campaign" and keeps that until it ends, whatever Settings says. ' +
        "Lower or remove the floor in Settings, or revert the campaign and apply it again, so it starts under the store's " +
        'policy now, "Clamp it to the floor and carry on".',
    );
  });

  it("is told to change the setting before starting again, while the store's is Block too", () => {
    const text = blockedMessage([gloves], "preview", { policy: "block", kept: true, store: "block" });
    expect(text).toMatch(/^A guardrail set to block the whole campaign would stop it before anything is written: /);
    expect(text).toContain(
      'Lower or remove the floor in Settings, or set "When a price would breach a floor" to clamp or skip, then revert the campaign and apply it again.',
    );
    expect(text).not.toContain(SETTING);
  });

  it("is still asked for the missing costs, and not to take variants out of a running campaign", () => {
    const text = blockedMessage([{ title: "Socks", reason: "missing-cost" }], "run", { policy: "block", kept: true, store: "skip" });
    expect(text).toContain('Lower or remove the floor in Settings, record the missing costs, or revert the campaign and apply it again, so it starts under the store\'s policy now, "Skip that variant, price the rest".');
    expect(text).not.toContain("out of the campaign's products");
  });

  it("is what it always was for a campaign the store's setting still reaches", () => {
    // A draft, a scheduled campaign, a finished one applied again: changing the setting reaches it.
    for (const store of ["block", "clamp"] as const) {
      expect(blockedMessage([gloves], "run", { policy: store, kept: false, store })).toBe(blockedMessage([gloves], "run"));
    }
    expect(blockedMessage([gloves], "run")).toContain(SETTING);
    // Keeping Clamp and stopped anyway, with no other campaign named: a cost it needs, say.
    expect(blockedMessage([gloves], "run", { policy: "clamp", kept: true, store: "clamp" })).toContain(SETTING);
  });
});

describe("what a variant another running campaign's kept Block stops is told to do (#1169)", () => {
  const SETTING = 'or set "When a price would breach a floor" to clamp or skip instead of blocking.';
  const winter = { name: "Winter Sale", breach: { policy: "block", kept: true, store: "clamp" } } as const;

  it("names that campaign, and what reaches it: the floor, or starting it again", () => {
    // A revert handing the variant to "Winter Sale", or a draft "Winter Sale" outranks on it.
    expect(blockedMessage([{ ...gloves, by: winter }], "run")).toBe(
      'A guardrail stopped this run before anything was written: "Cascade Gloves 44 · L" would be $0.33 in "Winter Sale", ' +
        'under its $10.00 floor. "Winter Sale" is a running campaign that started under "Block the whole campaign" and keeps ' +
        "that until it ends, whatever Settings says. Lower or remove the floor in Settings, or revert \"Winter Sale\" and apply it " +
        'again, so it starts under the store\'s policy now, "Clamp it to the floor and carry on".',
    );
  });

  it("is told to change the setting before starting that campaign again, while the store's is Block too", () => {
    const text = blockedMessage([{ ...gloves, by: { ...winter, breach: { ...winter.breach, store: "block" } } }], "preview");
    expect(text).toContain(
      'Lower or remove the floor in Settings, or set "When a price would breach a floor" to clamp or skip, then revert "Winter Sale" and apply it again.',
    );
    expect(text).not.toContain(SETTING);
    expect(text).not.toContain("out of the campaign's products");
  });

  it("is told what reaches the campaign planned for its own variants, and what reaches the other for its", () => {
    const socks: BlockedLine = { title: "Socks", reason: "missing-cost" };
    const text = blockedMessage([gloves, { ...gloves, title: "Cascade Gloves 44 · M", by: winter }, { ...socks, by: winter }], "run");
    expect(text).toContain('"Cascade Gloves 44 · L" would be $0.33, under its $10.00 floor; "Cascade Gloves 44 · M" would be $0.33 in "Winter Sale"');
    expect(text).toContain('; "Socks" in "Winter Sale": no cost recorded.');
    // The planned campaign's one variant, then Winter Sale's two, the costs among them.
    expect(text).toContain(`take this variant out of the campaign's products, ${SETTING} "Winter Sale" is a running campaign`);
    expect(text).toContain('Lower or remove the floor in Settings, record the missing costs, or revert "Winter Sale" and apply it again');
  });

  it("names each campaign that keeps Block, once", () => {
    const autumn = { ...winter, name: "Autumn Sale" };
    const text = blockedMessage([{ ...gloves, by: winter }, { ...gloves, by: autumn }, { ...gloves, by: winter }], "run");
    expect(text).toContain('"Winter Sale" and "Autumn Sale" are running campaigns that each started under "Block the whole campaign"');
    expect(text).toContain("or revert each and apply it again, so it starts under the store's policy now");
  });

  it("does not name a campaign that keeps Clamp or Skip, which is not what stopped it", () => {
    for (const policy of ["clamp", "skip"] as const) {
      const by = { name: "Winter Sale", breach: { policy, kept: true, store: "clamp" } } as const;
      expect(blockedMessage([{ ...gloves, by }], "run")).toBe(blockedMessage([gloves], "run"));
    }
  });
});

describe("what a campaign that chose Block itself is told to do (#816)", () => {
  it("before it starts: choose clamp or skip for it, since Settings does not reach it", () => {
    const text = blockedMessage([gloves], "preview", { policy: "block", kept: false, store: "clamp", own: true }, true);
    expect(text).toContain(
      'This campaign chose "Block the whole campaign" itself, whatever Settings says. Lower the floor in Settings or in ' +
        "this campaign's own floors, take this variant out of the campaign's products, or choose clamp or skip for this " +
        "campaign instead of blocking.",
    );
  });

  it("once started: revert it and choose again, since starting again does not hand it the store's", () => {
    const text = blockedMessage([gloves], "run", { policy: "block", kept: true, store: "clamp", own: true });
    expect(text).toContain(
      'This campaign chose "Block the whole campaign" itself and keeps that until it ends, whatever Settings says. ' +
        "Lower or remove the floor in Settings, or revert the campaign, choose clamp or skip for it, and apply it again.",
    );
    expect(text).not.toContain("starts under the store's policy");
  });

  it("names its own floors as a place to lower one, only where it sets any", () => {
    expect(blockedMessage([gloves], "run", undefined, true)).toContain("Lower the floor in Settings or in this campaign's own floors,");
    expect(blockedMessage([gloves], "run")).toContain("Lower the floor in Settings,");
  });

  it("names another running campaign that chose Block, and what reaches it", () => {
    const text = blockedMessage(
      [{ ...gloves, by: { name: "Clearance", breach: { policy: "block", kept: true, store: "clamp", own: true } } }],
      "run",
    );
    expect(text).toContain('"Clearance" is a running campaign that chose "Block the whole campaign" and keeps that until it ends');
    expect(text).toContain('or revert "Clearance", choose clamp or skip for it, and apply it again.');
  });
});
