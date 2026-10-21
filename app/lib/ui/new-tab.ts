/**
 * The name of a link that opens a new tab, saying that it does (#798).
 *
 * A link that leaves the frame for a new tab is a different thing to press than one that
 * stays: the merchant's place in the app is behind them in another tab, and the Back
 * button does nothing. Sighted merchants were told by an `external` icon on one of these,
 * and by nothing on the rest; a screen reader got neither, because the icon is decorative.
 *
 * Said in the name rather than in visually hidden text inside the link, because most of
 * these already carry an `accessibilityLabel`, and a label replaces the link's text — a
 * hidden phrase inside it would never be read.
 *
 * `screen-reader-names.test.tsx` checks every `target="_blank"` in the app is named with
 * this, so the next one cannot be written without it.
 */
export const NEW_TAB = "(opens in a new tab)";

export function newTabName(name: string): string {
  return `${name} ${NEW_TAB}`;
}
