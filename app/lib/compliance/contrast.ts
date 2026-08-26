/**
 * WCAG contrast ratios, computed rather than eyeballed.
 *
 * Built for Shopify asks for AA, and the parts of this app that Polaris renders are
 * Shopify's problem. The help centre is not: it ships its own stylesheet, deliberately,
 * because it is the page a merchant reaches when something else has already gone wrong
 * and one fewer asset to fetch is one fewer thing to fail. That stylesheet is ours to get
 * right, in both the light and dark palettes.
 *
 * The arithmetic is the WCAG 2.1 definition verbatim — relative luminance with the sRGB
 * transfer function, then `(lighter + 0.05) / (darker + 0.05)`. Written out rather than
 * pulled in, because it is fifteen lines and a dependency that computes one number is a
 * dependency that can be wrong in a way nobody notices.
 */

/** AA for body text. */
export const AA_NORMAL = 4.5;
/** AA for text at 18.66px bold or 24px regular, and for UI component boundaries. */
export const AA_LARGE = 3;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rrggbb` or `#rgb`. Anything else is a mistake worth throwing over. */
export function parseHex(hex: string): Rgb {
  const value = hex.trim().replace(/^#/, "");

  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;

  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new RangeError(`Not a hex colour: ${hex}`);
  }

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** Relative luminance, WCAG 2.1 §relativeluminancedef. */
export function luminance({ r, g, b }: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Contrast between two colours, from 1 (identical) to 21 (black on white).
 *
 * Symmetric by construction: which one is the text and which the background does not
 * change the ratio, and a version that assumed an order would be wrong half the time.
 */
export function contrastRatio(a: string, b: string): number {
  const first = luminance(parseHex(a));
  const second = luminance(parseHex(b));

  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + 0.05) / (darker + 0.05);
}
