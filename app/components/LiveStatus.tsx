import { forwardRef, type CSSProperties } from "react";

/**
 * Words a screen reader says when something changes, without moving anybody's focus (#798).
 *
 * The editor's preview recalculating, a CSV landing in the drop zone, a page finishing its
 * load: each changed on screen and said nothing, because changed text is only read when
 * somebody goes looking for it. A live region is how a page says "this just happened"
 * without taking the merchant away from what they were doing.
 *
 * ## The two rules that make one work, both easy to break
 *
 * **It announces its content, never its label.** The progress bar this replaces had
 * `role="status"` and `aria-label="Loading"` and no text, and nothing was ever spoken.
 * The message here is the element's text, and nothing else is.
 *
 * **It has to exist before the change.** A region that mounts with its sentence already
 * inside is, to most screen readers, not a change at all. So the caller renders this
 * unconditionally — empty while there is nothing to say — and changes the message. Put
 * one inside a branch that only renders once there is news, and it is silent.
 *
 * Polite, so it waits for the screen reader to finish its sentence rather than cutting in;
 * atomic, so a change from "3 of 5" to "4 of 5" reads the whole sentence and not "4".
 *
 * ## Why a `div` and not `s-box accessibilityRole="status"`
 *
 * Polaris offers the role, and puts it on an element inside the box's shadow root, around
 * a slot. The message would then be light-DOM text slotted into a shadow-DOM live region,
 * which is exactly the arrangement screen readers have been least consistent about
 * announcing. A plain element in the page's own DOM is the one shape every one of them
 * handles, so this is listed in `polaris-props.test.ts` as a place native HTML is the
 * only reliable answer.
 *
 * Visually hidden with the same declarations Polaris uses for its own `exclusive` text, so
 * it takes no space in whatever layout it is dropped into: absolutely positioned, it is
 * not a flex or grid item, and adds no gap to the stack around it.
 *
 * `message` is optional for the one caller that writes the region itself — the navigation
 * announcer, which can only know the new page's name after the new page has rendered. With
 * no `message`, React renders no children and leaves whatever that caller wrote alone.
 */
export const LiveStatus = forwardRef<HTMLDivElement, { message?: string }>(function LiveStatus(
  { message },
  ref,
) {
  return (
    <div ref={ref} role="status" aria-live="polite" aria-atomic="true" style={VISUALLY_HIDDEN}>
      {message}
    </div>
  );
});

/** Polaris' own `.visually-hidden`, read out of `polaris.js`, so ours hides the same way. */
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  inlineSize: "1px",
  blockSize: "1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};
