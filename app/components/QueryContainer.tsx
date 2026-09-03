import type { ReactNode } from "react";

/**
 * The thing a `@container` value is measured against.
 *
 * Seven layouts in this app choose their columns with a Polaris responsive value —
 * `"@container (inline-size <= 700px) 1fr, 1fr 1fr"` — and every one of them was being
 * measured against nothing.
 *
 * A CSS container query resolves against the **nearest ancestor container**, and an
 * element only becomes one if something sets `container-type` on it. Polaris sets it in
 * exactly one place, which its own types spell out: "We place the container name of
 * `s-default` on every container… @implementation You must always have a CSS
 * `container-name` of `s-default` for this component" — the component being
 * `s-query-container`, which this app had never used. No container, no match, so the
 * value silently fell through to its unmatched branch on every screen.
 *
 * ## How it showed
 *
 * The campaign editor. `FieldGrid` says it becomes one column at 700px, and the editor's
 * form column is about 470px — so its four selects should have been full width there.
 * They rendered as two columns of roughly 220px, which is why "Set to baseline (shows a
 * strike-through)" and "Leave prices exactly as calculated · $12.34" arrived as "Set to
 * baseline (shows a strik…" and "Leave prices exactly as calc…". Three of the four
 * selects in the create flow could not be read at the width they were given, on the
 * page where a trial is won or lost.
 *
 * The same grid on the settings page, in a 970px card, renders two columns and looks
 * right. That is what made this invisible for so long: the unmatched branch is the
 * correct layout for the widest place the component is used, so the bug only appears
 * where the container is narrow — and the narrower the space, the more it matters.
 *
 * ## What it does not fix
 *
 * A container established here measures the space this component was given. It does not
 * make anything responsive to the window, and it must not be hoisted to the page to
 * "cover" several grids at once — a grid measured against the page rather than against
 * its own column is exactly the state this replaces.
 */
export function QueryContainer({ children }: { children: ReactNode }) {
  return <s-query-container>{children}</s-query-container>;
}
