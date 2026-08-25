/**
 * A market's standing adjustment, in words.
 *
 * Basis points are how the number is stored — integers, never a float near a price —
 * but "-1000" tells a merchant nothing. This is the line beside each market checkbox
 * that says which price their discount will be calculated from, and getting the
 * direction wrong there is the difference between a sale and a price rise.
 */
export function describeAdjustment(bps: number): string {
  if (bps === 0) return "the same as";

  const percent = Math.abs(bps) / 100;
  const rounded = Number.isInteger(percent) ? String(percent) : percent.toFixed(2);

  return bps < 0 ? `${rounded}% below` : `${rounded}% above`;
}
