import { resultBanner, type ActionOutcome } from "../lib/dashboard/action-result";

/**
 * The banner an action's reply is shown in, on Home and on the campaign page.
 *
 * Both pages used to write it out inline, mapping the reply's list of lines straight.
 * Some replies have no list -- a resolved market notice on Home (#610); a saved note, an
 * approval request or decision on the campaign page (#714) -- and mapping undefined
 * replaced the page with the error screen after the work had already been done. The
 * reply goes through `resultBanner`, which is the one place that knows that.
 */
export function ResultBanner({ result }: { result: ActionOutcome | undefined }) {
  const banner = resultBanner(result);
  if (!banner) return null;

  return (
    <s-banner tone={banner.tone}>
      <s-paragraph>{banner.message}</s-paragraph>
      {banner.lines.map((line) => (
        <s-paragraph key={line}>{line}</s-paragraph>
      ))}
    </s-banner>
  );
}
