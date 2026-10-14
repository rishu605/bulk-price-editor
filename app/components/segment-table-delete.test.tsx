/**
 * The segments table offers Delete unless a live campaign needs the segment, and says
 * what to do when one does (#776).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SegmentTable, type SegmentRow } from "./SegmentTable";

const segments: SegmentRow[] = [
  { id: "seg_import", name: "Sale · 25 Sep 2026 (imported)", kind: "FROZEN", size: 4, usedBy: [{ id: "c1", name: "Sale · 25 Sep 2026", status: "DRAFT" }] },
  { id: "seg_live", name: "Summer", kind: "DYNAMIC", size: 12, usedBy: [{ id: "c2", name: "Black Friday", status: "ACTIVE" }] },
];

const rowOf = (html: string, name: string) => html.split("<s-table-row").slice(1).find((row) => row.includes(name)) ?? "";

describe("deleting from the segments table", () => {
  it("offers Delete for a segment only a draft uses, and names the step for one a live campaign uses", () => {
    const html = renderToStaticMarkup(<SegmentTable segments={segments} Form={"form" as never} busy={false} />);
    expect(rowOf(html, "(imported)")).toContain(">Delete<");
    const live = rowOf(html, ">Summer<");
    expect(live).not.toContain(">Delete<");
    expect(live).toContain("In use by &quot;Black Friday&quot;: revert it first");
    expect(html).not.toContain("remove from campaigns");
  });

  it("turns that row's Delete into a confirmation once the page has asked", () => {
    const html = renderToStaticMarkup(
      <SegmentTable segments={segments} Form={"form" as never} busy={false} confirmingDelete="seg_import" />,
    );
    const row = rowOf(html, "(imported)");
    expect(row).toContain(">Delete anyway<");
    expect(row).toContain('name="acknowledged" value="1"');
  });
});
