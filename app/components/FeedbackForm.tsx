import { useFetcher } from "react-router";

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
export function FeedbackForm({ route }: { route: string }) {
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const busy = fetcher.state !== "idle";

  return (
    <s-section heading="Tell us how this is going">
      {fetcher.data ? (
        <s-banner tone={fetcher.data.ok ? "success" : "warning"}>
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <fetcher.Form method="post" action="/app/feedback">
        <input type="hidden" name="route" value={route} />
        <s-stack gap="base">
          <s-select name="sentiment" label="What kind of thing is this?">
            <s-option value="problem" defaultSelected>
              Something is wrong
            </s-option>
            <s-option value="idea">An idea</s-option>
            <s-option value="praise">Something worked well</s-option>
          </s-select>

          <s-text-area
            name="message"
            label="What happened?"
            rows={4}
            placeholder="A sentence is enough."
            details="We can see which screen you are on and what your store looks like, so you do not need to explain that part."
          />

          <s-button type="submit" loading={busy || undefined}>
            Send
          </s-button>
        </s-stack>
      </fetcher.Form>
    </s-section>
  );
}
