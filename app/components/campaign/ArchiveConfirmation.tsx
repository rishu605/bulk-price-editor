import type { MutableRefObject } from "react";

import type { ArchiveWarning } from "../../lib/campaigns/archive-warning";
import { SPACE } from "../../lib/ui/spacing";
import { Secondary } from "../Type";

/** A literal, for the reason `RevertConfirmation` gives about `commandFor`. */
export const ARCHIVE_MODAL_ID = "archive-confirmation";

/** The dialog as the header holds it: opened from the More actions menu by a click. */
export type ArchiveModal = HTMLElement & { showOverlay?: () => void };

/**
 * What archiving a live or scheduled campaign leaves running, before it is archived (#748).
 *
 * Archive sat beside Duplicate in the overflow, at the same weight and with nothing in
 * between, and took an Active campaign out of the list with its prices live. Archiving stays
 * allowed (D19): this is the sentence that was missing, said first. A draft, a finished
 * campaign and a cancelled one have nothing running, and are archived in one click as before.
 *
 * Opened by `showOverlay` from the menu item's click rather than `commandFor`: Polaris
 * documents a menu's buttons as acting through `onClick` or `href`, and Duplicate beside it
 * already does.
 */
export function ArchiveConfirmation({
  campaignName,
  warning,
  modalRef,
  busy,
  onConfirm,
}: {
  campaignName: string;
  warning: ArchiveWarning;
  modalRef: MutableRefObject<ArchiveModal | null>;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <s-modal
      id={ARCHIVE_MODAL_ID}
      heading={`Archive ${campaignName}?`}
      ref={(element) => {
        modalRef.current = element;
      }}
    >
      <s-stack gap={SPACE.section}>
        <s-paragraph>
          <s-text type="strong">{warning.keeps}</s-text>
        </s-paragraph>
        <s-paragraph>
          Archiving only takes it out of the campaigns list. It does not stop, end or unschedule
          it: the list keeps a count of it until it has finished, and Restore puts it back.
        </s-paragraph>
        {warning.instead ? <Secondary>{warning.instead}</Secondary> : null}
      </s-stack>

      {/* Not "Cancel": on a scheduled campaign that is the name of the button that calls it off. */}
      <s-button slot="secondary-actions" commandFor={ARCHIVE_MODAL_ID} command="--hide">
        Keep it in the list
      </s-button>
      {/* `variant="primary"` because the slot takes nothing else (#609). No critical tone:
          archiving destroys nothing, and Restore undoes it. */}
      <s-button
        slot="primary-action"
        variant="primary"
        loading={busy || undefined}
        commandFor={ARCHIVE_MODAL_ID}
        command="--hide"
        onClick={onConfirm}
      >
        Archive campaign
      </s-button>
    </s-modal>
  );
}
