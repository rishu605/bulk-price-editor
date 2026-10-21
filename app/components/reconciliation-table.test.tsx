/**
 * What's live keeps a long product name inside its card at phone width (#1023).
 *
 * Each row's name was a tertiary `s-button`, and Polaris never lets a button's label wrap:
 * at 390px a seventy-character product and variant title ran past the card and pushed
 * "Because of" off it. Nothing threw, and every short fixture fitted, so it read as a page
 * that worked.
 *
 * This suite has no layout engine, so it asserts what decides it: the name is text that
 * can wrap -- a link, inside text -- and not a button. `scripts/measure-narrow-tables.ts`
 * measures the real thing at 390px, with a seventy-character title among its fixtures.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReconciliationTable } from "./ReconciliationTable";
import { newTabName } from "../lib/ui/new-tab";
import type { ReconciliationRow } from "../services/reconciliation.server";

const TITLE = "The Collection Snowboard: Liquid, Limited Edition, Wide Fit 158 Bundle";
const ADMIN = "https://admin.shopify.com/store/boltify-apps/products/1";

const row: ReconciliationRow = {
  variantGid: "gid://shopify/ProductVariant/1",
  title: TITLE,
  sku: "SNOW-LIQ-158WB",
  priceListGid: "",
  surface: "Base price",
  currency: "USD",
  live: "812.50",
  baseline: "902.78",
  campaignId: "c1",
  campaignName: "10% off everything",
  intended: "812.50",
  drifted: false,
  offBaseline: true,
  adminUrl: ADMIN,
} as ReconciliationRow;

const html = renderToStaticMarkup(<ReconciliationTable rows={[row]} clearHref="/app/prices/live" />);

/** The cell holding the product name. */
const nameCell = [...html.matchAll(/<s-table-cell>([\s\S]*?)<\/s-table-cell>/g)]
  .map((match) => match[1])
  .find((cell) => cell.includes(TITLE));

describe("the product name on What's live (#1023)", () => {
  it("is still a link to the product in Shopify, in a new tab", () => {
    expect(nameCell).toBeDefined();
    expect(nameCell).toMatch(new RegExp(`<s-link[^>]*href="${ADMIN}"[^>]*target="_blank"`));
  });

  it("is not a button, whose label Polaris never wraps", () => {
    expect(nameCell).not.toContain("<s-button");
  });

  it("is a link inside text, which Polaris draws in the text's colour rather than as a column of blue", () => {
    // `tone="neutral"` on the link is in the types and styled by nothing: a "neutral" link
    // is drawn link-blue. Inside `s-text` it takes the text's colour and an underline.
    expect(nameCell).toMatch(/^<s-text><s-link\b[^>]*>[^<]*<\/s-link><\/s-text>$/);
  });

  it("says where it goes, which the colour no longer does", () => {
    // And that it goes there in a new tab, which nothing else on the link says (#798).
    expect(nameCell).toContain(`accessibilityLabel="${newTabName(`Open ${TITLE} in Shopify`)}"`);
  });
});
