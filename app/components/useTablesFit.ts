import { useCallback, useRef } from "react";

import { fitTable } from "../lib/ui/table-fit";

/**
 * Every table on a page, drawn as a list whenever its grid does not fit (#804).
 *
 * Returns a ref for the page's `s-page`. `fitTable` says why the decision is the app's to
 * make; this is the part that watches. It measures each `s-table` inside the page and sets
 * its `variant` attribute, which is the attribute Polaris reads and the one React 18 would
 * have set from a prop.
 *
 * ## Why from the page, not from each table
 *
 * Because it covers every table there is, including the ones written next month. Twenty-odd
 * tables are bare `<s-table>`s in components and routes; a `<Table>` wrapper would be a
 * twenty-file change that the next table forgets. `PageShell` renders every page, so the
 * page is the one place a rule about all of them can live. The cost is that a route reading
 * `<s-table>` cannot see this from where it stands, so `table-fit.test.ts` refuses a table
 * that sets `variant` itself: React would put it back on every render and the two would
 * take turns.
 *
 * A callback ref rather than an element held in state: state would render the whole page a
 * second time on every mount just to learn which element it had rendered.
 */
export function useTablesFit(): (page: HTMLElement | null) => void {
  const stop = useRef<(() => void) | null>(null);

  return useCallback((page: HTMLElement | null) => {
    stop.current?.();
    stop.current = page ? watchTables(page) : null;
  }, []);
}

/**
 * Fits every table inside `page` now and whenever anything could change the answer.
 * Returns the function that stops watching.
 *
 * ## What it watches, and why each
 *
 * - **The page's own DOM**, for tables that arrive later: a fetcher's result, a tab, a
 *   modal's contents.
 * - **Each table's shadow root**, because Polaris draws the grid after the element
 *   upgrades and redraws it when the variant changes, and neither is a change to anything
 *   React rendered.
 * - **The size of the table's box and of its grid.** The box changes with the frame, the
 *   aside folding under, a tab being shown; the grid changes when its rows do.
 *
 * ## What it reads inside Polaris
 *
 * Two things from each table's open shadow root: its first element, the box the table is
 * drawn in, and `[role="grid"]`, which is there only while it is drawn as a grid. The host
 * itself is `display: contents` and measures zero. If Polaris changes either, nothing is
 * found, nothing is set, and tables behave exactly as they did before this existed.
 * `scripts/measure-narrow-tables.ts` is how to find out: it renders the pages in real
 * Chrome with the live `polaris.js` and fails on any clipped cell.
 *
 * Measured and written in an animation frame rather than inside the observers, so a
 * change of layout is never made in the middle of the browser reporting one -- which is
 * what "ResizeObserver loop completed with undelivered notifications" means.
 */
export function watchTables(page: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};

  /** The grid width each table had when it was asked for a list. */
  const needed = new WeakMap<Element, number>();
  /** Observing an element twice restarts its observation, which reports it again. */
  const watched = new WeakSet<object>();
  let frame = 0;

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(fit);
  };
  const sizes = new ResizeObserver(schedule);
  const redraws = new MutationObserver(schedule);
  const arrivals = new MutationObserver(schedule);

  function watchSize(element: Element | null) {
    if (!element || watched.has(element)) return;
    watched.add(element);
    sizes.observe(element);
  }

  function fit() {
    frame = 0;
    for (const table of page.querySelectorAll("s-table")) {
      const root = table.shadowRoot;
      if (!root) continue;
      if (!watched.has(root)) {
        watched.add(root);
        redraws.observe(root, { childList: true, subtree: true });
      }

      const box = root.firstElementChild;
      const grid = root.querySelector('[role="grid"]');
      watchSize(box);
      watchSize(grid);
      if (!box) continue;

      const change = fitTable({
        layout: grid ? "table" : "list",
        available: box.getBoundingClientRect().width,
        grid: grid ? grid.getBoundingClientRect().width : null,
        needed: needed.get(table) ?? null,
      });
      if (!change) continue;

      if (change.variant === "list") needed.set(table, change.needed);
      else needed.delete(table);
      table.setAttribute("variant", change.variant);
    }
  }

  arrivals.observe(page, { childList: true, subtree: true });
  schedule();

  return () => {
    cancelAnimationFrame(frame);
    sizes.disconnect();
    redraws.disconnect();
    arrivals.disconnect();
  };
}
