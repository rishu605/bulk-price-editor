import { useEffect, useState } from "react";

import { copyText } from "../lib/ui/clipboard";
import { showToast } from "../lib/ui/toast";
import { SPACE } from "../lib/ui/spacing";
import { Caption } from "./Type";

/**
 * An ID a merchant has to paste somewhere else, shown, with a button that copies it (#826).
 *
 * Shopify Flow's actions ask for a campaign ID or a segment ID, and the app showed
 * neither. A campaign's was only in the browser's address bar, which the Flow help text
 * did not mention. A segment's was nowhere: only a hidden input on the Delete form. So
 * "Capture baselines for a segment" could not be set up at all.
 *
 * ## Shown as well as copied
 *
 * The copy can be refused (see `copyText`), and a merchant checking which campaign a Flow
 * points at needs to read the ID, not only paste it. Text that can be selected by hand
 * is the fallback for every case the button does not cover.
 *
 * ## Why the button is tertiary and has no words
 *
 * It sits beside the thing it copies, on every row of the segments table, and copying
 * changes nothing. That is the `ActionRow` rule for a quiet row control: tertiary, and
 * only ever with an icon. The accessible name says what it copies, because "Copy" alone,
 * read out once per row, does not say which ID.
 *
 * ## The confirmation
 *
 * Two, because they answer different people. The icon turns into a tick for a moment,
 * which is where the merchant is looking. The admin's toast is what a screen reader
 * announces, and the only place a refusal can say what to do instead.
 */
export function CopyableId({
  value,
  what,
  label,
  quiet = false,
}: {
  /** The ID itself. */
  value: string;
  /** What it is, in words: "campaign ID". Used in the confirmation. */
  what: string;
  /** The button's accessible name. Defaults to "Copy campaign ID"; a table row adds whose. */
  label?: string;
  /** Subdued, for an ID under the name it belongs to rather than the value of a fact. */
  quiet?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    const ok = await copyText(value);
    setCopied(ok);
    showToast(
      ok
        ? `${what.charAt(0).toUpperCase()}${what.slice(1)} copied`
        : `The browser blocked copying the ${what}. Select it and press Ctrl+C, or ⌘C on a Mac.`,
      !ok,
    );
  };

  return (
    <s-stack direction="inline" gap={SPACE.tight} alignItems="center">
      {quiet ? <Caption>{value}</Caption> : <s-text>{value}</s-text>}
      {/* `variant` and `icon` ahead of `onClick`: the arrow's `>` ends what a source scan
          reads as this tag, and the action vocabulary test looks for the icon in it. */}
      <s-button
        variant="tertiary"
        icon={copied ? "clipboard-check" : "clipboard"}
        accessibilityLabel={label ?? `Copy ${what}`}
        onClick={() => void copy()}
      />
    </s-stack>
  );
}

