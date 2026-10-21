/**
 * The absence of a value, in a table.
 *
 * Every table in this app writes `—` where a row has no SKU, no cost, no compare-at. At
 * full text weight that dash reads as *content*: on the catalogue, a store with no SKUs
 * renders a column of forty identical dashes with exactly the visual weight of the prices
 * beside them, and the eye keeps stopping on them. Three of the seven columns can look
 * like that at once.
 *
 * Subdued, so the column reads as empty at a glance and the numbers are the only things
 * with weight. This is `neutral`/de-emphasis rather than a status tone — it says "there is
 * nothing here", which is not information a reader loses without colour, so it does not
 * fall under the WCAG rule `colour-signal.test.ts` enforces.
 *
 * An em dash and not "None" or an empty cell. Empty reads as a rendering failure — the
 * merchant cannot tell a missing value from a broken page — and a word in every gap is
 * more noise than the dash it replaces.
 *
 * ## What it says aloud
 *
 * To the eye, that is. A screen reader read the dash as "em dash", or skipped it — and in
 * the plan table's Markets and Wholesale columns, where "—" stands for *No*, skipping it
 * left a listener with "Free" and then the next plan's name (#798). So the dash is hidden
 * from screen readers and a visually hidden word stands in for it: "None" by default,
 * which is what an empty cell means, and whatever `means` says where the column is a
 * question with a different answer.
 */
export function Blank({ means = "None" }: { means?: string }) {
  return (
    <s-text color="subdued">
      <s-text accessibilityVisibility="hidden">—</s-text>
      <s-text accessibilityVisibility="exclusive">{means}</s-text>
    </s-text>
  );
}
