/**
 * Three small counts that read wrong (#728).
 */

import { describe, expect, it } from "vitest";

import { countOf } from "../../lib/format/display";
import { sourceOf } from "../../lib/testing/source";

import { tabsFor } from "./CampaignTabs";

describe("counts that read right", () => {
  it("badges the Ledger tab with the run's rows, not the capped page of them", () => {
    const tabs = tabsFor({ runs: [{}], rollback: null, ledger: new Array(60).fill({}), ledgerTotal: 3_669 });
    expect(tabs.find((tab) => tab.id === "ledger")?.badge).toBe(3_669);
  });

  it("says one variant, and groups the rest", () => {
    expect(countOf(1, "variant")).toBe("1 variant");
    expect(countOf(3_669, "variant")).toBe("3,669 variants");
    expect(countOf(2, "entry", "entries")).toBe("2 entries");
  });

  it("counts cost coverage over live variants on both sides, so it cannot pass 100%", () => {
    expect(sourceOf("app/routes/app.settings._index.tsx")).toContain(
      "prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null, cost: { not: null } } })",
    );
  });
});
