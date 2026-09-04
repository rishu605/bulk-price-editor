import { useEffect, useRef } from "react";
import { useBlocker, useNavigation } from "react-router";

import { hasChanged, snapshotOf } from "../lib/ui/dirty";
import { ActionRow } from "./ActionRow";

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
 * ## Why a banner and not a dialog
 *
 * The app confirms destructive things inline — the recapture page asks for a typed
 * confirmation rather than opening a modal — and a browser `confirm()` inside the admin's
 * iframe is both ugly and not guaranteed to be permitted. So the block renders as the
 * app's own banner, and scrolls itself into view: a warning at the top of a page the
 * merchant has scrolled to the bottom of would look exactly like the click doing nothing.
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
  const pristine = useRef<string | null>(null);
  const banner = useRef<HTMLElement | null>(null);
  const submitting = useRef(false);
  const navigation = useNavigation();

  useEffect(() => {
    if (form.current) pristine.current = snapshotOf(form.current);
  }, [form]);

  // Whatever is in the form now is what was accepted, so it is the new starting point.
  useEffect(() => {
    if (saved && form.current) pristine.current = snapshotOf(form.current);
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
      hasChanged(form.current ? snapshotOf(form.current) : null, pristine.current),
  );

  useEffect(() => {
    if (blocker.state === "blocked") banner.current?.scrollIntoView({ block: "center" });
  }, [blocker.state]);

  if (blocker.state !== "blocked") return null;

  return (
    <s-banner
      ref={banner as never}
      tone="warning"
      heading={`Leave without keeping ${describe}?`}
    >
      <s-paragraph>
        Nothing here has been saved yet, so leaving this page discards it. Going back is
        the only thing that keeps it.
      </s-paragraph>
      <ActionRow>
        <s-button variant="primary" onClick={() => blocker.reset?.()}>
          Stay on this page
        </s-button>
        <s-button variant="secondary" onClick={() => blocker.proceed?.()}>
          Leave and discard
        </s-button>
      </ActionRow>
    </s-banner>
  );
}
