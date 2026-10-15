/**
 * A ledger row says which price it is (#887).
 *
 * A campaign that prices a market writes a row per surface for each variant, and the
 * Ledger tab showed them as identical-looking rows: nothing said which was the base price
 * and which the market, or that the market's amounts were in another currency.
 *
 * Through the real apply, `runLedger` and the Ledger table.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LedgerTable } from "../../app/components/LedgerTable";
import prisma from "../../app/db.server";
import { runLedger } from "../../app/services/campaigns/history.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const EUR = "gid://shopify/PriceList/ledger-surface-eu";

describe("chaos: the ledger of a campaign that prices a market", () => {
  it("names each row's surface and currency", async () => {
    await withChaos("ledger-surface", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      chaos.fake.addPriceList({
        id: EUR,
        name: "Europe",
        currency: "EUR",
        country: "DE",
        adjustment: { type: "PERCENTAGE_DECREASE", value: 10 },
        catalog: { id: "gid://shopify/MarketCatalog/ledger-surface-eu", title: "EU", __typename: "MarketCatalog" },
        prices: [],
      });
      const { syncMarkets } = await import("../../app/services/markets-sync.server");
      await syncMarkets(chaosAdminClient(chaos.server.endpoint()), shopId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { surfaces: { base: true, priceLists: [EUR] } as never } });

      const applied = await chaos.apply();
      const rows = (await runLedger(shopId, applied.runId)).filter((row) => row.variantGid === variantGids[0]);
      const surfaces = rows.map((row) => `${row.surface} (${row.currency})`).sort();
      expect(surfaces, "the rows do not say which price each is").toEqual(["Base price (USD)", "Europe (EUR)"]);

      const html = renderToStaticMarkup(createElement(LedgerTable, { rows }));
      expect(html).toContain("Base price (USD)");
      expect(html).toContain("Europe (EUR)");
    });
  });
});
