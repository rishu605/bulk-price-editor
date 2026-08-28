import { Outlet } from "react-router";

import { SectionTabs } from "../components/SectionTabs";

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
      {/* The section's own landing page is the first tab.

          It was not in this list at all, so `/app/imports` — the list of files a merchant
          has imported, and where the nav item points — rendered a bar of four links with
          *nothing selected*, and no way back to it once you left. `SectionTabs` matches
          the current path exactly, deliberately (a section root prefixes every tab under
          it), which is precisely why an index that is not listed can never be current. */}
      <SectionTabs
        tabs={[
          { href: "/app/imports", label: "Files" },
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
