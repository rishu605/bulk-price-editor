import { Outlet } from "react-router";

import { SectionTabs } from "../components/SectionTabs";

/**
 * The settings section: the things a merchant opens once, or when something is wrong.
 *
 * Segments, plan, feedback and diagnostics were four more top-level nav items between
 * them, all rarely visited. Diagnostics in particular is linked from runbooks and is
 * followed while something is going wrong, which is why `/app/settings/diagnostics` still resolves.
 */
export default function SettingsSection() {
  return (
    <>
      <SectionTabs
        tabs={[
          { href: "/app/settings", label: "Guardrails, rounding & alerts" },
          { href: "/app/settings/segments", label: "Segments" },
          { href: "/app/settings/plan", label: "Plan" },
          { href: "/app/settings/feedback", label: "Feedback" },
          { href: "/app/settings/diagnostics", label: "Diagnostics" },
        ]}
      />
      <Outlet />
    </>
  );
}
