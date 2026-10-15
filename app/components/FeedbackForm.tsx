import { useEffect, useRef, useSyncExternalStore } from "react";
import { useFetcher } from "react-router";

import { KIND_LABELS, lastScreen } from "../lib/feedback/feedback-ui";
import { Field } from "./FieldGrid";
import { SPACE } from "../lib/ui/spacing";
import { Card } from "./Card";

/**
 * The feedback box, on every screen.
 *
 * Deliberately three sentiments and one field. Every extra question is a reason somebody
 * closes the form instead of sending, and the context that a longer form would ask for —
 * which screen, which plan, how big the catalogue — is captured automatically because we
 * already know it.
 *
 * No screenshot capture. Inside Shopify's admin the app runs in a cross-origin iframe and
 * cannot see the surrounding page; the only browser API that could is screen capture,
 * which prompts for permission to record the merchant's entire display. Asking a merchant
 * to share their screen so they can report a typo is a worse trade than not having the
 * screenshot, so the route is recorded instead and the message field does the rest.
 */
export function FeedbackForm() {
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const busy = fetcher.state !== "idle";

  // The screen the merchant came from (#743). Storage is the browser's, so the server
  // renders without it and the client reads it once hydrated.
  const route = useSyncExternalStore(noSubscription, lastScreen, () => null);

  // A fresh form once a message is in (#743): the text stayed with Send enabled, and a
  // second press filed it twice. The text area is cleared by its property as well as by
  // the reset, which a custom element may not take.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.ok || !form.current) return;
    form.current.reset();
    const area = form.current.querySelector("s-text-area") as (HTMLElement & { value?: string }) | null;
    if (area) area.value = "";
  }, [fetcher.state, fetcher.data]);

  return (
    <Card heading="Tell us how this is going">  {fetcher.data ? (
        <s-banner tone={fetcher.data.ok ? "success" : "warning"}>
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <fetcher.Form ref={form} method="post" action="/app/settings/feedback">
        <input type="hidden" name="route" value={route ?? ""} />
        <s-stack gap={SPACE.section}>
          {/* Three options and a sentence. Unbounded these filled a 970px card, which
              asks for an essay and offers a dropdown the width of the screen. */}
          <Field width="medium">
            <s-select name="sentiment" label="What kind of thing is this?">
              <s-option value="problem" defaultSelected>
                {KIND_LABELS.problem}
              </s-option>
              <s-option value="idea">{KIND_LABELS.idea}</s-option>
              <s-option value="praise">{KIND_LABELS.praise}</s-option>
            </s-select>
          </Field>

          <Field width="long">
            <s-text-area
              name="message"
              label="What happened?"
              rows={4}
              placeholder="A sentence is enough."
              // Only claims the screen when it has one (#743).
              details={
                route
                  ? `We will see that you came here from ${route}, and what your store looks like, so you do not need to explain that part.`
                  : "Say which screen it happened on. We can see what your store looks like, so you do not need to explain that part."
              }
            />
          </Field>

          <s-button type="submit" loading={busy || undefined}>
            Send
          </s-button>
        </s-stack>
      </fetcher.Form>
    </Card>
  );
}

/** The remembered screen does not change while this page is open. */
function noSubscription() {
  return () => {};
}
