import { useRef, type ElementRef } from "react";

import { SPACE } from "../../lib/ui/spacing";
import { FieldGrid } from "../FieldGrid";
import { Secondary } from "../Type";

/**
 * Literal ids, for the reason `RevertConfirmation` gives: `commandFor` is typed
 * `Lowercase<string>`, and an id assembled at runtime is a button that opens nothing.
 */
export const EDIT_DATES_MODAL_ID = "edit-schedule-dates";
export const CALL_OFF_MODAL_ID = "call-off-schedule";

/** The dates as the fields take them, and the start as the dialogs name it. */
export interface ScheduledWindow {
  /** `YYYY-MM-DDTHH:MM` in the store's zone. */
  start: string;
  /** Likewise, or "" for a window that runs until reverted by hand. */
  end: string;
  /** "27 Nov 2026, 09:00 (America/New_York)". */
  startText: string;
}

/**
 * The header's two controls for a campaign that has not started (#760).
 *
 * A scheduled campaign offered Duplicate, Archive -- which files it away and leaves it to
 * run on its date -- a Revert that did nothing (#749), and Apply, which starts it now.
 * Nothing on the page stopped it or moved its date. These say what they do in their labels.
 */
export function ScheduleButtons({ busy }: { busy?: boolean }) {
  return (
    <>
      <s-button icon="calendar" loading={busy || undefined} commandFor={EDIT_DATES_MODAL_ID} command="--show">
        Edit dates
      </s-button>
      <s-button
        variant="tertiary"
        tone="critical"
        icon="x-circle"
        loading={busy || undefined}
        commandFor={CALL_OFF_MODAL_ID}
        command="--show"
      >
        Cancel or unschedule
      </s-button>
    </>
  );
}

/**
 * The two dialogs those buttons open. Outside the header's row, like the other modals:
 * a modal is not an action, and its primary button would count as a second black one.
 */
export function ScheduleModals({
  campaignName,
  window,
  busy,
  onSave,
  onUnschedule,
  onCancel,
}: {
  campaignName: string;
  window: ScheduledWindow;
  busy?: boolean;
  onSave: (fields: { startDate: string; startTime: string; endDate: string; endTime: string }) => void;
  onUnschedule: () => void;
  onCancel: () => void;
}) {
  // Read on save rather than held in state: the fields are Polaris elements whose own
  // value is the truth, and only an `s-button` can be a modal's primary action -- there is
  // no form to submit, so the values are collected the way `ApplyConfirmation` collects
  // its confirmation word.
  const startDate = useRef<ElementRef<"s-date-field">>(null);
  const startTime = useRef<ElementRef<"s-text-field">>(null);
  const endDate = useRef<ElementRef<"s-date-field">>(null);
  const endTime = useRef<ElementRef<"s-text-field">>(null);
  const read = (field: { value?: string } | null) => String(field?.value ?? "").trim();

  return (
    <>
      <s-modal id={EDIT_DATES_MODAL_ID} heading={`Change when ${campaignName} runs`}>
        <s-stack gap={SPACE.section}>
          <s-paragraph>
            It starts {window.startText}. New dates take effect at once; nothing is written to
            your storefront until the new start.
          </s-paragraph>
          <FieldGrid>
            <s-date-field ref={startDate} name="startDate" label="Start" value={window.start.slice(0, 10)} />
            <s-text-field
              ref={startTime}
              name="startTime"
              label="Start time"
              placeholder="09:00"
              value={window.start.slice(11)}
              details="24-hour, in your store's zone."
            />
            <s-date-field ref={endDate} name="endDate" label="End (optional)" value={window.end.slice(0, 10)} />
            <s-text-field
              ref={endTime}
              name="endTime"
              label="End time"
              placeholder="23:59"
              value={window.end.slice(11)}
              details="Defaults to the end of that day."
            />
          </FieldGrid>
        </s-stack>

        <s-button slot="secondary-actions" commandFor={EDIT_DATES_MODAL_ID} command="--hide">
          Close
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          loading={busy || undefined}
          commandFor={EDIT_DATES_MODAL_ID}
          command="--hide"
          onClick={() =>
            onSave({
              startDate: read(startDate.current),
              startTime: read(startTime.current),
              endDate: read(endDate.current),
              endTime: read(endTime.current),
            })
          }
        >
          Save dates
        </s-button>
      </s-modal>

      <s-modal id={CALL_OFF_MODAL_ID} heading={`Stop ${campaignName} from starting?`}>
        <s-stack gap={SPACE.section}>
          <s-paragraph>
            <s-text type="strong">It is scheduled to start {window.startText}.</s-text> Nothing has
            been written to your storefront yet, and neither choice writes anything.
          </s-paragraph>
          <s-stack gap={SPACE.item}>
            <s-paragraph>
              <s-text type="strong">Unschedule</s-text> — back to a draft with no dates. It will not
              start until you schedule it again or apply it.
            </s-paragraph>
            <s-paragraph>
              <s-text type="strong">Cancel campaign</s-text> — called off for good. It never runs; you
              can still duplicate it to make a new one.
            </s-paragraph>
          </s-stack>
          <Secondary>To start it now instead, close this and use Apply to storefront.</Secondary>
        </s-stack>

        <s-button slot="secondary-actions" commandFor={CALL_OFF_MODAL_ID} command="--hide">
          Keep it scheduled
        </s-button>
        <s-button
          slot="secondary-actions"
          loading={busy || undefined}
          commandFor={CALL_OFF_MODAL_ID}
          command="--hide"
          onClick={onUnschedule}
        >
          Unschedule
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          loading={busy || undefined}
          commandFor={CALL_OFF_MODAL_ID}
          command="--hide"
          onClick={onCancel}
        >
          Cancel campaign
        </s-button>
      </s-modal>
    </>
  );
}
