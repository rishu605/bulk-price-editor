import type { LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { SectionTabs } from "../components/SectionTabs";
import prisma from "../db.server";

/**
 * The prices section: five views of the same variant rows.
 *
 * Catalogue, baselines, costs, what is live and drift were five top-level nav items and
 * five separate tables, each with its own filtering, paging and empty state — a
 * thousand lines to show one thing with different columns.
 *
 * The loader exists for one number. Drift is the case a merchant will not go looking
 * for: someone edited a price by hand under a running campaign, and nothing about the
 * storefront looks wrong. Putting the count on the tab means it is noticed without
 * being opened, which is the difference between a diagnostic and a warning.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  // PENDING, matching what the drift tab itself lists. Counting unresolved by
  // `resolvedAt: null` would also include events a merchant has already decided on but
  // whose resolution has not been stamped, and a badge that disagrees with the page it
  // points at is worse than no badge.
  const drifted = await prisma.driftEvent.count({
    where: { shopId: shop.id, resolution: "PENDING" },
  });

  return { drifted };
};

export default function PricesSection() {
  const { drifted } = useLoaderData<typeof loader>();

  return (
    <>
      <SectionTabs
        tabs={[
          { href: "/app/prices", label: "Variants" },
          { href: "/app/prices/baselines", label: "Baselines" },
          { href: "/app/prices/costs", label: "Costs" },
          { href: "/app/prices/live", label: "What's live" },
          // "Price drift", the page's own heading. It said "Drift" while the page said
          // "Price drift" and Home linked to it as the "Drift queue" — three names for
          // one destination, which is the thing this section was already worst at.
          { href: "/app/prices/drift", label: "Price drift", badge: drifted },
        ]}
      />
      <Outlet />
    </>
  );
}
