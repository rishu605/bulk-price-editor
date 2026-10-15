import { useEffect, useRef } from "react";
import { useBlocker, useNavigation } from "react-router";

import { snapshotOf } from "../lib/ui/dirty";
import { LeaveGuard, TOUCH_EVENTS } from "../lib/ui/leave-guard";

/**
 * Stops a half-filled form being thrown away by a click.
 *
 * The campaign editor takes a name, a scope, a rule, rounding, surfaces and a schedule
 * before it is worth submitting, and every one of those lives in the form rather than in
 * anything persisted. Any navigation — the back link above the title, a nav item, the
 * browser's own back button — unmounts the route and takes the lot with it. That is the
 * trap this exists to close, and it is the reason the back link could not simply be
 * added on its own.
 *
 * ## Why a dialog
 *
 * A browser `confirm()` inside the admin's iframe is both ugly and not guaranteed to be
 * permitted. It was the app's own banner, scrolled into view -- but the scroll that matters
 * is the admin page around the iframe, so from a click at the foot of the editor the banner
 * stayed off screen and the click looked like it did nothing (#761). A Polaris modal is
 * shown in view wherever the page is scrolled.
 *
 * ## What it does not cover
 *
 * `useBlocker` sees client-side navigation. A full page load — the browser's reload
 * button, a typed URL — is outside it, and `beforeunload` is deliberately not added: the
 * admin renders this app in an iframe, and a browser-level "leave site?" prompt on a
 * click inside an embedded app is more alarming than the loss it prevents.
 */
export function UnsavedChanges({
  form,
  /** What the merchant would be walking away from, in their words. */
  describe = "what you have entered",
  /**
   * The form's contents have been accepted, so they are no longer only in the form.
   *
   * Without this the guard raises a false alarm on the way out of a page whose work is
   * already done — an import that has run, and whose CSV is still sitting in the
   * textarea. A warning that fires when nothing is at stake is how merchants learn to
   * click through the one that matters.
   */
  saved = false,
}: {
  form: React.RefObject<HTMLFormElement | null>;
  describe?: string;
  saved?: boolean;
}) {
  const guard = useRef(new LeaveGuard());
  const modal = useRef<(HTMLElement & { showOverlay?: () => void; hideOverlay?: () => void }) | null>(null);
  const submitting = useRef(false);
  const navigation = useNavigation();

  // The clean state is read at the merchant's first touch, not at mount (#761): the
  // Polaris fields register their values after this component mounts, so a mount
  // snapshot made every untouched form look changed.
  useEffect(() => {
    const element = form.current;
    if (!element) return;
    const touched = () => guard.current.touch(snapshotOf(element));
    for (const type of TOUCH_EVENTS) element.addEventListener(type, touched, true);
    return () => {
      for (const type of TOUCH_EVENTS) element.removeEventListener(type, touched, true);
    };
  }, [form]);

  // Whatever is in the form now is what was accepted, so it is the new starting point.
  useEffect(() => {
    if (saved && form.current) guard.current.accept(snapshotOf(form.current));
  }, [saved, form]);

  // A page's own submit is not somebody walking away from their work — it is the work
  // being done. The campaign editor posts and is redirected to the campaign it created,
  // and without this the guard would stop that redirect to ask whether to discard a
  // campaign that now exists.
  useEffect(() => {
    const element = form.current;
    if (!element) return;

    const onSubmit = () => {
      submitting.current = true;
    };
    element.addEventListener("submit", onSubmit);
    return () => element.removeEventListener("submit", onSubmit);
  }, [form]);

  // Re-armed once the submission settles without leaving: an action that came back with
  // an error leaves the merchant on the page, still holding everything they typed.
  useEffect(() => {
    if (navigation.state === "idle") submitting.current = false;
  }, [navigation.state]);

  const blocker = useBlocker(
    // Same-URL navigations are not leaving: a fetcher re-running or a search param the
    // page sets itself would otherwise raise this over the merchant's own typing.
    ({ currentLocation, nextLocation }) =>
      !submitting.current &&
      currentLocation.pathname !== nextLocation.pathname &&
      guard.current.wouldDiscard(form.current ? snapshotOf(form.current) : null),
  );

  // A dialog, not a banner (#761): the admin scrolls the page around this iframe, so a
  // banner at the top of the form -- even scrolled "into view" from inside -- was off
  // screen from a click at the bottom, and the click looked like it did nothing.
  useEffect(() => {
    if (blocker.state === "blocked") modal.current?.showOverlay?.();
  }, [blocker.state]);

  // Closed any other way -- Escape, the close button -- is staying. Heard natively, as
  // React 18 does not deliver a custom element's events through props (#863).
  const reset = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    reset.current = blocker.state === "blocked" ? blocker.reset : undefined;
  }, [blocker]);
  useEffect(() => {
    const element = modal.current;
    if (!element) return;
    const stay = () => reset.current?.();
    element.addEventListener("hide", stay);
    return () => element.removeEventListener("hide", stay);
  }, []);

  return (
    <s-modal
      heading={`Leave without keeping ${describe}?`}
      ref={(element) => {
        modal.current = element;
      }}
    >
      <s-paragraph>
        Nothing here has been saved yet, so leaving this page discards it. Staying keeps it.
      </s-paragraph>
      <s-button
        slot="secondary-actions"
        onClick={() => {
          blocker.reset?.();
          modal.current?.hideOverlay?.();
        }}
      >
        Stay on this page
      </s-button>
      <s-button slot="primary-action" variant="primary" tone="critical" onClick={() => blocker.proceed?.()}>
        Leave and discard
      </s-button>
    </s-modal>
  );
}
