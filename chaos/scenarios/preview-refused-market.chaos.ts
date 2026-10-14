/**
 * A market the campaign refuses to price has no column in its preview or its export (#770).
 *
 * A price list that answers in the wrong currency is refused: the preview gives it no
 * cells, and the Markets card says why. The table and the CSV still gave it a column, so
 * every row read "Not sold here" -- on products Shopify sells there at their normal price.
 *
 * Through the real `previewCampaign`, then the table and the file the page builds from it.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreviewTable } from "../../app/components/PreviewTable";
import prisma from "../../app/db.server";
import { previewCsv } from "../../app/lib/reporting/preview-csv";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const REFUSED = "gid://shopify/PriceList/refused-eu";
const PRICED = "gid://shopify/PriceList/priced-jp";

describe("chaos: previewing a campaign that refuses one of its markets", () => {
  it("gives the refused market no column, and keeps the one it prices", async () => {
    await withChaos("preview-refused-market", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      chaos.fake.addPriceList({
        id: REFUSED,
        name: "Refused Europe",
        currency: "EUR",
        country: "DE",
        answersInCurrency: "USD",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: "gid://shopify/MarketCatalog/refused-eu", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      chaos.fake.addPriceList({
        id: PRICED,
        name: "Priced Japan",
        currency: "JPY",
        country: "JP",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: "gid://shopify/MarketCatalog/priced-jp", title: "JP", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { surfaces: { base: true, priceLists: [REFUSED, PRICED] } as never },
      });

      const preview = await previewCampaign(shopId, campaignId, { client: chaosAdminClient(chaos.server.endpoint()) });
      // The premise: one market refused and named on the Markets card, one priced.
      expect(preview.markets.find((m) => m.priceListGid === REFUSED)?.refused, "the market was not refused").toBe(true);
      expect(preview.markets.find((m) => m.priceListGid === PRICED)?.refused).toBe(false);
      expect(preview.rows.length).toBeGreaterThan(0);

      const table = renderToStaticMarkup(
        createElement(PreviewTable, { rows: preview.rows, markets: preview.markets, total: preview.counts.planned }),
      );
      expect(table, "the refused market has a column of its own").not.toContain("Refused Europe");
      expect(table, "products sold in the refused market read as not sold there").not.toContain("Not sold here");
      expect(table).toContain("Priced Japan (JPY)");

      const csv = previewCsv(preview.rows, preview.markets);
      const header = csv.split("\n")[0];
      expect(header, "the export gave the refused market a column").not.toContain("Refused Europe");
      expect(header).toContain('"Priced Japan (JPY)"');
      expect(csv).not.toContain("not sold here");
    });
  });
});
