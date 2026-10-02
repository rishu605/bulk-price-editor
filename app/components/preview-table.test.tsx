/**
 * The campaign page's preview names why a row was clamped or skipped in words (#792).
 *
 * It showed the planner's code -- "Clamped · non-positive-price" -- where the wizard's
 * preview showed the phrase.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreviewTable } from "./PreviewTable";
import type { PreviewRow } from "../services/campaigns/types";

const row = (over: Partial<PreviewRow>): PreviewRow =>
  ({ variantGid: "gid://v/1", title: "Cascade Gloves 44 · L", before: "0.37", after: "0.01", compareAt: null, status: "pending", ...over }) as PreviewRow;

describe("the preview table's state column", () => {
  it("phrases a clamp and a skip", () => {
    const html = renderToStaticMarkup(
      <PreviewTable
        rows={[
          row({ status: "clamped", reason: "non-positive-price" }),
          row({ variantGid: "gid://v/2", title: "Free sample", before: "0.00", after: null, status: "skipped", reason: "free-item" }),
        ]}
      />,
    );

    expect(html).toContain("Clamped · Would price at or below zero");
    expect(html).toContain("Skipped · Free item, left free");
    expect(html).not.toContain("non-positive-price");
  });
});
