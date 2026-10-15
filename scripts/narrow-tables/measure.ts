/**
 * What a merchant can see of every table cell on the page, measured in the browser.
 *
 * Runs inside the harness page, after Polaris has rendered. Two ways a cell loses content,
 * and #804 is the first of them:
 *
 * - **The table's own scroll box clips it.** In its grid layout `s-table` puts the table in
 *   a horizontally scrolling box, and a cell past the box's edge is cut there — "708.7"
 *   for 708.76 — with the scrollbar at the foot of the table, a screen below. The cell
 *   itself never overflows: a table cell grows to its content, so its own `scrollWidth`
 *   equals its `clientWidth` and a check of that alone passes on the broken page.
 * - **The cell's own box is narrower than its content.** In the list layout a price sits
 *   in a labelled pair, and a number has nowhere to wrap.
 *
 * So a cell is clipped when its content's rendered box reaches past either its own box or
 * the table's, whichever is tighter.
 */

/** One cell whose content does not fit where it is drawn. */
export interface ClippedCell {
  column: string;
  row: number;
  text: string;
  /** Pixels of content past the visible edge. */
  hidden: number;
}

export interface TableReport {
  /** The column headings, in order. */
  columns: string[];
  /** What Polaris drew: a grid, or a stack of labelled pairs. */
  layout: "table" | "list";
  /** The `variant` attribute the table carries, if anything set one. */
  variant: string | null;
  /** The width the table is given. */
  available: number;
  /** The grid's own width, while it is a grid. Wider than `available` means it scrolls. */
  grid: number | null;
  cells: number;
  moneyCells: number;
  clipped: ClippedCell[];
  clippedMoney: ClippedCell[];
}

export interface PageReport {
  page: string;
  /** The frame's width, which is what Polaris reads. */
  innerWidth: number;
  /** Space between the frame's edges and the first card, left and right. */
  gutters: [number, number];
  tables: TableReport[];
}

/** Half a pixel either way is rounding, not clipping. */
const TOLERANCE = 1;

const round = (value: number) => Math.round(value * 10) / 10;

/** The first element in an open shadow root, which is where Polaris draws a box. */
function drawn(host: Element): HTMLElement | null {
  return (host.shadowRoot?.firstElementChild as HTMLElement | null) ?? null;
}

/** The rendered extent of a cell's own content: its text and elements, not its padding. */
function contentBox(cell: Element): DOMRect | null {
  const range = document.createRange();
  range.selectNodeContents(cell);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return null;

  const left = Math.min(...rects.map((rect) => rect.left));
  const right = Math.max(...rects.map((rect) => rect.right));
  const top = Math.min(...rects.map((rect) => rect.top));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * The box the cell is drawn in.
 *
 * In the grid that is the cell's own table cell. In the list it is whatever the row put it
 * in -- a labelled pair's value, the inline strip -- which is the slot's parent in the
 * row's shadow root.
 */
function cellBox(cell: Element, layout: "table" | "list"): DOMRect | null {
  if (layout === "table") return drawn(cell)?.getBoundingClientRect() ?? null;
  const slot = (cell as HTMLElement).assignedSlot;
  return slot?.parentElement?.getBoundingClientRect() ?? null;
}

export function measureTable(table: Element): TableReport {
  const root = table.shadowRoot;
  const grid = root?.querySelector('[role="grid"]') ?? null;
  const layout = grid ? "table" : "list";
  const wrapper = drawn(table);
  const visible = wrapper?.getBoundingClientRect() ?? null;

  const headers = [...table.querySelectorAll("s-table-header")];
  const columns = headers.map((header) => header.textContent?.replace(/\s+/g, " ").trim() ?? "");
  const money = headers.map((header) => header.getAttribute("format") === "currency");

  const clipped: ClippedCell[] = [];
  const clippedMoney: ClippedCell[] = [];
  let cells = 0;
  let moneyCells = 0;

  [...table.querySelectorAll("s-table-row")].forEach((row, rowIndex) => {
    [...row.querySelectorAll(":scope > s-table-cell")].forEach((cell, index) => {
      const content = contentBox(cell);
      if (!content) return;
      cells += 1;
      if (money[index]) moneyCells += 1;

      const own = cellBox(cell, layout);
      const right = Math.min(own?.right ?? Infinity, visible?.right ?? Infinity);
      const left = Math.max(own?.left ?? -Infinity, visible?.left ?? -Infinity);
      const hidden = Math.max(content.right - right, left - content.left, 0);
      if (hidden <= TOLERANCE) return;

      const entry = {
        column: columns[index] ?? `column ${index + 1}`,
        row: rowIndex + 1,
        text: cell.textContent?.replace(/\s+/g, " ").trim() ?? "",
        hidden: round(hidden),
      };
      clipped.push(entry);
      if (money[index]) clippedMoney.push(entry);
    });
  });

  return {
    columns,
    layout,
    variant: table.getAttribute("variant"),
    available: round(visible?.width ?? 0),
    grid: grid ? round(grid.getBoundingClientRect().width) : null,
    cells,
    moneyCells,
    clipped,
    clippedMoney,
  };
}

/** Where the page's first card starts and ends, against the frame. */
function gutters(): [number, number] {
  const section = document.querySelector("s-section");
  const box = section ? drawn(section)?.getBoundingClientRect() : null;
  if (!box) return [0, 0];
  return [round(box.left), round(window.innerWidth - box.right)];
}

export function measurePage(page: string): PageReport {
  return {
    page,
    innerWidth: window.innerWidth,
    gutters: gutters(),
    tables: [...document.querySelectorAll("s-table")].map(measureTable),
  };
}

/** A fingerprint of every table's shape, to tell when the page has stopped changing. */
function shape(): string {
  return [...document.querySelectorAll("s-table")]
    .map((table) => {
      const grid = table.shadowRoot?.querySelector('[role="grid"]');
      const wrapper = drawn(table);
      return `${grid ? "table" : "list"}:${table.getAttribute("variant")}:${wrapper?.getBoundingClientRect().width ?? 0}`;
    })
    .join("|");
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until every table has rendered and nothing has changed for a few frames.
 *
 * Polaris renders its shadow roots after the element upgrades, and anything that adjusts a
 * table to its width does so after that, so measuring on the first frame would measure
 * the page before either had happened.
 */
export async function settled(): Promise<void> {
  await customElements.whenDefined("s-table");
  let last = "";
  let steady = 0;
  for (let i = 0; i < 60 && steady < 5; i += 1) {
    await frame();
    await pause(50);
    const now = shape();
    const ready = [...document.querySelectorAll("s-table")].every((table) => drawn(table));
    steady = ready && now === last ? steady + 1 : 0;
    last = now;
  }
}
