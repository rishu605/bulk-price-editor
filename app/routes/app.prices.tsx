import { Outlet } from "react-router";

import { SectionNav } from "../components/SectionNav";

/**
 * The prices section: five views of the same variant rows.
 *
 * Catalogue, baselines, costs, what is live and drift were five top-level nav items
 * and five separate tables, each with its own filtering, paging and empty state — 997
 * lines to show one thing with different columns. They are one section now; sharing
 * the table shell itself is P7.6.
 */
export default function PricesSection() {
  return (
    <>
      <SectionNav
        tabs={[
          { href: "/app/prices", label: "Variants" },
          { href: "/app/prices/baselines", label: "Baselines" },
          { href: "/app/prices/costs", label: "Costs" },
          { href: "/app/prices/live", label: "What's live" },
          { href: "/app/prices/drift", label: "Drift" },
        ]}
      />
      <Outlet />
    </>
  );
}
