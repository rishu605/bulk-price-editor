/**
 * Home's upcoming campaigns badge each one as the campaigns list does (#1056): a sale still
 * applying past its end reads "Applying — ending late" there too, not "Applying".
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UpcomingCampaigns } from "./UpcomingCampaigns";

const moment = { id: "c1", name: "Weekend", status: "APPLYING", kind: "ends" as const, at: "2026-10-16T00:00:00.000Z" };
const render = (moments: Array<typeof moment & { lifecycle?: { label: string; tone: string } }>) =>
  renderToStaticMarkup(<UpcomingCampaigns moments={moments} now="2026-10-15T12:00:00.000Z" timeZone="UTC" />);

describe("Home's upcoming campaigns (#1056)", () => {
  it("shows the list's label and tone for a campaign ending late", () => {
    const html = render([{ ...moment, lifecycle: { label: "Applying — ending late", tone: "warning" } }]);
    expect(html).toContain("Applying — ending late");
    expect(html).toContain('tone="warning"');
  });

  it("falls back to the bare state", () => {
    expect(render([moment])).toContain(">Applying<");
  });
});
