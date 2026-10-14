/**
 * A full row sits between grids, not across one (#725).
 *
 * Polaris reads `s-grid-item`'s `gridColumn` as `auto` or `span N` and nothing else -- a
 * container query in it becomes `auto` -- so no span can follow the grid's own breakpoint.
 * `SplitGrid` takes each `FullRow` out of the grid instead, which is right at every width.
 */

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FieldGrid, FullRow, splitAtFullRows } from "./FieldGrid";

const field = (name: string) => <s-text-field key={name} name={name} label={name} />;

/** Each `<s-grid>`'s inner markup, and what lies outside every grid. */
function grids(html: string): { inside: string[]; outside: string } {
  const inside: string[] = [];
  const outside = html.replace(/<s-grid\b[^>]*>([\s\S]*?)<\/s-grid>/g, (_m, inner: string) => {
    inside.push(inner);
    return "";
  });
  return { inside, outside };
}

describe("FieldGrid", () => {
  it("is one grid when nothing needs the whole row", () => {
    const html = renderToStaticMarkup(<FieldGrid>{[field("a"), field("b"), field("c")]}</FieldGrid>);
    expect(grids(html).inside).toHaveLength(1);
    expect(html).not.toContain("<s-stack");
  });

  it("puts a full row between two grids, not inside one", () => {
    const html = renderToStaticMarkup(
      <FieldGrid>
        {field("a")}
        {field("b")}
        <FullRow>
          <s-checkbox name="guard" label="Never below cost" />
        </FullRow>
        {field("c")}
      </FieldGrid>,
    );
    const { inside, outside } = grids(html);
    expect(inside).toHaveLength(2);
    expect(inside[0]).toContain('name="a"');
    expect(inside[0]).toContain('name="b"');
    expect(inside[1]).toContain('name="c"');
    expect(outside, "the full row is inside a grid").toContain('name="guard"');
    expect(html).not.toMatch(/gridcolumn|gridColumn/i);
  });

  it("opens fragments, where the editor's conditional full rows live", () => {
    const conditional = (show: boolean): ReactNode =>
      show ? (
        <>
          {field("x")}
          <FullRow>
            <s-checkbox name="inner" label="Inner" />
          </FullRow>
        </>
      ) : null;
    const html = renderToStaticMarkup(
      <FieldGrid>
        {field("a")}
        {conditional(true)}
        {conditional(false)}
      </FieldGrid>,
    );
    const { inside, outside } = grids(html);
    expect(outside).toContain('name="inner"');
    expect(inside[0]).toContain('name="a"');
    expect(inside[0]).toContain('name="x"');
  });

  it("gives every cell a key of its own, fragments included", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderToStaticMarkup(
      <FieldGrid>
        <>{field("a")}</>
        <>{field("a2")}</>
        <FullRow>
          <s-text>full</s-text>
        </FullRow>
      </FieldGrid>,
    );
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/same key|unique "key"/);
    error.mockRestore();
  });
});

describe("splitAtFullRows", () => {
  it("keeps the order: cells, the full row, cells", () => {
    const runs = splitAtFullRows([field("a"), <FullRow key="f">full</FullRow>, field("b")]);
    expect(runs.map((run) => run.full)).toEqual([false, true, false]);
  });
});
