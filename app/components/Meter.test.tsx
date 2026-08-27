/**
 * The bar is decoration that has to be honest: it sits beside a figure, and a bar that
 * disagrees with the number next to it is worse than no bar.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Meter } from "./Meter";

/**
 * The fill's width is the only thing this component says.
 *
 * The *last* `inlineSize` in the markup, not the first: the track is also a box and it is
 * always 100%, so a lazier match reads the container and reports every meter as full.
 */
const width = (value: number, max: number) => {
  const sizes = [
    ...renderToStaticMarkup(<Meter value={value} max={max} />).matchAll(/inlineSize="(\d+%)"/g),
  ];
  return sizes[sizes.length - 1]?.[1];
};

describe("the meter", () => {
  it("fills in proportion", () => {
    expect(width(1, 4)).toBe("25%");
    expect(width(3, 4)).toBe("75%");
  });

  it("is empty rather than NaN when there is nothing to measure", () => {
    // A shop with no variants yet is a real state, not a bug.
    expect(width(0, 0)).toBe("0%");
  });

  it("clamps past full, because more baselines than variants is expected here", () => {
    // Baselines are kept for deleted products, so the numerator legitimately exceeds the
    // denominator — and a 104% bar would overflow its track.
    expect(width(9200, 9145)).toBe("100%");
  });

  it("clamps a negative to empty", () => {
    expect(width(-5, 10)).toBe("0%");
  });
});
