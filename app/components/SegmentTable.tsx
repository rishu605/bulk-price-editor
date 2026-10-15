import { useEffect, useRef } from "react";
import type { FetcherWithComponents } from "react-router";

import { formatCount } from "../lib/format/display";
import { deleteBlockedReason } from "../lib/segments/delete-rule";
import { focusAfterRemoval } from "../lib/ui/focus-after-removal";
import { SPACE } from "../lib/ui/spacing";
import { ActionRow } from "./ActionRow";
import { Blank } from "./Blank";
import { CopyableId } from "./CopyableId";

/** One row: what `listSegments` returns, as far as the table reads it. */
export interface SegmentRow {
  id: string;
  name: string;
  kind: string;
  size: number;
  usedBy: Array<{ id: string; name: string; status: string }>;
}

/**
 * Settings → Segments' table.
 *
 * Out of the route so it can be rendered in a test: the ID under each name (#826) is the
 * only place a merchant can find what Shopify Flow's "Capture baselines for a segment"
 * asks for, and an assertion about that belongs on the rendered row, not on the source.
 *
 * ## Where the ID goes
 *
 * Under the name, quiet, with its copy button beside it — not a column of its own. The
 * table already has five, and an ID is looked up once, when an automation is set up, so
 * it should not take width from the four columns a merchant scans every visit.
 */
export function SegmentTable({
  segments,
  Form,
  busy,
  confirmingDelete,
}: {
  segments: SegmentRow[];
  /** The page's fetcher form, so a delete's reply reaches the page's banner. */
  Form: FetcherWithComponents<unknown>["Form"];
  busy: boolean;
  /**
   * The segment whose Delete was answered with "these campaigns use it" (#776). Its button
   * now confirms: the same control, pressed again, deletes.
   */
  confirmingDelete?: string;
}) {
  // A deleted segment's row leaves with its focused button; focus goes to the row that took
  // its place rather than the page body (#796). A refused or confirming delete keeps the row,
  // so nothing moves.
  const table = useRef<HTMLElement | null>(null);
  const deleting = useRef<number | null>(null);
  const count = useRef(segments.length);
  useEffect(() => {
    if (deleting.current !== null && segments.length < count.current) {
      focusAfterRemoval(table.current, deleting.current, null);
      deleting.current = null;
    }
    count.current = segments.length;
  }, [segments.length]);

  return (
    <s-table
      ref={(element) => {
        table.current = element;
      }}
    >
      <s-table-header-row>
        <s-table-header listSlot="primary">Name</s-table-header>
        <s-table-header listSlot="inline">Kind</s-table-header>
        {/* Variants, which is what it counts (#742): a list of 3 products and 4
            variants read "Products: 4". */}
        <s-table-header listSlot="labeled" format="numeric">Variants</s-table-header>
        <s-table-header listSlot="secondary">Used by</s-table-header>
        <s-table-header listSlot="inline">Action</s-table-header>
      </s-table-header-row>
      <s-table-body>
        {segments.map((segment, index) => (
          <s-table-row key={segment.id}>
            <s-table-cell>
              <s-stack gap={SPACE.tight}>
                <s-text>{segment.name}</s-text>
                <CopyableId
                  value={segment.id}
                  what="segment ID"
                  label={`Copy the segment ID of “${segment.name}”`}
                  quiet
                />
              </s-stack>
            </s-table-cell>
            <s-table-cell>
              <s-badge tone={segment.kind === "DYNAMIC" ? "info" : "neutral"}>
                {segment.kind === "DYNAMIC" ? "Dynamic" : "Frozen"}
              </s-badge>
            </s-table-cell>
            <s-table-cell>{variantCount(segment.size)}</s-table-cell>
            <s-table-cell>
              {segment.usedBy.length === 0 ? (
                <Blank />
              ) : (
                segment.usedBy.map((c) => c.name).join(", ")
              )}
            </s-table-cell>
            <s-table-cell>
              <ActionRow>
              {/* A link, so the form it opens survives a reload (#742). */}
              <s-button variant="secondary" icon="edit" href={`?edit=${segment.id}`} accessibilityLabel={`Edit ${segment.name}`}>
                Edit
              </s-button>
              {deleteBlockedReason(segment.usedBy) ? (
                // Not a disabled button: a control that does nothing invites
                // clicking it repeatedly. The reason is the answer, and it names the
                // campaign and what to do to it (#776).
                <s-text>{deleteBlockedReason(segment.usedBy)}</s-text>
              ) : (
                <Form method="post" onSubmit={() => (deleting.current = index)}>
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="segmentId" value={segment.id} />
                  {confirmingDelete === segment.id ? <input type="hidden" name="acknowledged" value="1" /> : null}
                  {/* Bordered, like every other row action that changes something.
                      Deleting a segment is the most consequential thing this table
                      does, and it was the quietest control on the page. */}
                  <s-button
                    type="submit"
                    tone="critical"
                    variant="secondary"
                    icon="delete"
                    loading={busy || undefined}
                    accessibilityLabel={`${confirmingDelete === segment.id ? "Delete anyway" : "Delete"}: ${segment.name}`}
                  >
                    {confirmingDelete === segment.id ? "Delete anyway" : "Delete"}
                  </s-button>
                </Form>
              )}
              </ActionRow>
            </s-table-cell>
          </s-table-row>
        ))}
      </s-table-body>
    </s-table>
  );
}

/** The count column's text: a number, grouped like every other count in the app. */
function variantCount(size: number): string {
  return formatCount(size);
}
