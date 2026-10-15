import { hasChanged } from "./dirty";

/**
 * Whether leaving a form throws away something the merchant did (#761).
 *
 * The clean state used to be read at mount. The editor's fields are Polaris custom elements,
 * and they register their values with the form after React's mount effect has run, so the
 * mount snapshot described a form with fewer values than the one on screen: every later
 * snapshot differed, and leaving an untouched New campaign raised "Leave without keeping
 * this campaign?" -- the page merchants open most, warning about work nobody did.
 *
 * So the clean state is read at the merchant's first touch -- a press, a key, a paste, a
 * drop, which all arrive before the value they change -- by when every field has long since
 * registered. Before any touch there is nothing of theirs to lose.
 */
export class LeaveGuard {
  private pristine: string | null = null;

  /** The merchant is about to change something: the form as it is now is the clean state. */
  touch(snapshot: string): void {
    if (this.pristine === null) this.pristine = snapshot;
  }

  /** What the form holds was accepted (an import that ran): that is the new clean state. */
  accept(snapshot: string): void {
    this.pristine = snapshot;
  }

  /** Whether leaving with the form as `current` discards something the merchant did. */
  wouldDiscard(current: string | null): boolean {
    return hasChanged(current, this.pristine);
  }
}

/** The events that come before a merchant's change, never after it. */
export const TOUCH_EVENTS = ["pointerdown", "keydown", "paste", "drop"] as const;
