/**
 * The starter file for a price import.
 *
 * All three competitors offer one, and it is the difference between "paste a CSV" and a
 * merchant guessing at column names — which is the failure that produces a file where
 * every row matched nothing, after they have already exported it from their own system.
 *
 * A route rather than a static asset, because the currency in the example has to be the
 * shop's own: a US merchant shown `129.00` and a Japanese merchant shown `129.00` are
 * being told different things, and only one of them is true. Nothing here is a real
 * price — the SKUs are obviously placeholders — so this is a template, not data.
 *
 * The `[.csv]` in the filename is React Router's escape for a literal dot in a flat
 * route, so the path is `/app/campaigns/template.csv` and the browser saves something
 * with an extension a spreadsheet will open.
 */

import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import { isZeroDecimal } from "../lib/money/currency";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const currency = await shopCurrency(shop.id);

  // Whole numbers where the currency has no sub-unit. A template showing "129.00" to a
  // JPY store teaches a merchant to write a column the importer will reject on every row.
  const example = (major: number) => (isZeroDecimal(currency) ? `${major}` : `${major}.00`);

  const rows = [
    "Variant SKU,Variant Price",
    `EXAMPLE-1,${example(129)}`,
    `EXAMPLE-2,${example(149)}`,
    `EXAMPLE-3,${example(99)}`,
  ];

  return new Response(`${rows.join("\n")}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="price-import-template-${currency}.csv"`,
      // Not cached: the currency comes from the shop, and a cached copy would hand a
      // second store the first one's example.
      "Cache-Control": "no-store",
    },
  });
};
