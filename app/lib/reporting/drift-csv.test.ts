import { describe, expect, it } from "vitest";

import type { DriftRow } from "../../services/drift.server";
import { driftCsv } from "./drift-csv";

const row = (overrides: Partial<DriftRow> = {}): DriftRow => ({
  id: "e1",
  variantGid: "gid://shopify/ProductVariant/1",
  title: 'Monitor, 24" · Black',
  sku: "MON-24",
  observed: "1299.00",
  expected: "1039.20",
  currency: "USD",
  direction: "up",
  campaignId: "c1",
  campaignName: "Autumn sale",
  detectedAt: "2026-10-15T08:30:00.000Z",
  stillShown: true,
  ...overrides,
});

describe("the drift queue as a file", () => {
  it("has a row per drifted price with both prices as plain numbers", () => {
    const [header, line] = driftCsv([row()]).trim().split("\n");
    expect(header).toBe(
      '"Variant ID","Title","Variant SKU","Campaign","Campaign set","Now shows","Currency","Direction","Still on the storefront","Detected at"',
    );
    expect(line).toBe(
      '"gid://shopify/ProductVariant/1","Monitor, 24"" · Black","MON-24","Autumn sale","1039.20","1299.00","USD","Raised","Yes","2026-10-15T08:30:00.000Z"',
    );
  });

  it("leaves unknown values blank rather than guessing", () => {
    const [, line] = driftCsv([
      row({ title: "Scarf", sku: null, campaignName: null, expected: null, direction: null, stillShown: false }),
    ])
      .trim()
      .split("\n");
    expect(line).toBe(
      '"gid://shopify/ProductVariant/1","Scarf","","","","1299.00","USD","","No","2026-10-15T08:30:00.000Z"',
    );
  });
});
