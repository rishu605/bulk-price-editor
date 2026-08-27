import { useEffect, useRef } from "react";

/**
 * Shopify's own save bar, for the settings form.
 *
 * The admin puts "Unsaved changes · Discard · Save" in the top bar the moment a field
 * changes, and merchants expect it because every other page in the admin has it. Ours
 * had a submit button at the bottom of each section, so changing a value in the third
 * section meant scrolling past two others to save it.
 *
 * It needed the three forms merged into one first. One save bar wired to one of three
 * forms is worse than none: it would appear for a change in one section and not the
 * others, and a merchant learns it is unreliable rather than that it is partial.
 *
 * Deliberately not on the campaign editor. A save bar says "you have changed something
 * that exists"; the editor *creates* a campaign, and offering Discard on a thing that
 * has never existed invites the question of what it would discard.
 *
 * Dirty state is read from the form rather than mirrored into React state. Mirroring
 * means two sources of truth for "has this changed", and the one that goes stale is the
 * one deciding whether the merchant is warned before leaving.
 */
export function SettingsSaveBar({
  form,
  saving,
  id = "settings-save-bar",
}: {
  form: React.RefObject<HTMLFormElement | null>;
  saving: boolean;
  id?: string;
}) {
  const pristine = useRef<string | null>(null);

  useEffect(() => {
    const element = form.current;
    if (!element) return;

    const snapshot = () =>
      new URLSearchParams(new FormData(element) as unknown as string[][]).toString();
    pristine.current = snapshot();

    const bar = () =>
      (
        globalThis as {
          shopify?: { saveBar?: { show(id: string): void; hide(id: string): void } };
        }
      ).shopify?.saveBar;

    const onChange = () => {
      const control = bar();
      if (!control) return; // Outside the admin frame — a test, or a direct page load.
      if (snapshot() !== pristine.current) control.show(id);
      else control.hide(id);
    };

    element.addEventListener("input", onChange);
    element.addEventListener("change", onChange);
    return () => {
      element.removeEventListener("input", onChange);
      element.removeEventListener("change", onChange);
    };
  }, [form, id]);

  // After a save the form's current values become the new pristine state, or the bar
  // stays up over a form that already matches what is stored.
  useEffect(() => {
    if (saving || !form.current) return;
    pristine.current = new URLSearchParams(
      new FormData(form.current) as unknown as string[][],
    ).toString();
    (globalThis as { shopify?: { saveBar?: { hide(id: string): void } } }).shopify?.saveBar?.hide(
      id,
    );
  }, [saving, form, id]);

  return (
    <ui-save-bar id={id}>
      <button variant="primary" onClick={() => form.current?.requestSubmit()}>
        {saving ? "Saving…" : "Save"}
      </button>
      <button
        onClick={() => {
          // Reset restores every section, not only the one that was touched — which is
          // the point of them being one form.
          form.current?.reset();
          (
            globalThis as { shopify?: { saveBar?: { hide(id: string): void } } }
          ).shopify?.saveBar?.hide(id);
        }}
      >
        Discard
      </button>
    </ui-save-bar>
  );
}
