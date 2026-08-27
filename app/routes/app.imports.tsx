import { Outlet } from "react-router";

import { SectionNav } from "../components/SectionNav";

/**
 * The imports section: one verb that used to have three destinations.
 *
 * Importing prices, baselines and costs are the same flow — upload a CSV, map columns,
 * dry run, review, commit — differing only in which columns they target. Recapture
 * joins them because it is a bulk baseline write, and it keeps its typed confirmation
 * exactly as it was. Collapsing the three into one source picker is P7.7.
 */
export default function ImportsSection() {
  return (
    <>
      <SectionNav
        tabs={[
          { href: "/app/imports/prices", label: "Prices" },
          { href: "/app/imports/baselines", label: "Baselines" },
          { href: "/app/imports/costs", label: "Costs" },
          { href: "/app/imports/recapture", label: "Recapture baselines" },
        ]}
      />
      <Outlet />
    </>
  );
}
