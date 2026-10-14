/**
 * Putting a string on the merchant's clipboard, from inside the admin's iframe (#826).
 *
 * Two ways, tried in order, because the app runs in a cross-origin iframe and whether the
 * asynchronous Clipboard API is allowed there is the embedding page's decision, not ours:
 *
 * 1. `navigator.clipboard.writeText` — the standard way, and the only one that is not
 *    deprecated. Refused (it rejects) when the frame lacks the `clipboard-write`
 *    permission.
 * 2. `document.execCommand("copy")` on a hidden text area — older, deprecated, and still
 *    honoured in a frame during a click, which is when this runs.
 *
 * Neither is guaranteed, so the answer is a boolean the caller has to say something about,
 * and every caller shows the text it copies as well. A copy the browser refused leaves the
 * merchant something to select by hand rather than a button that silently did nothing.
 */

/** What the copy needs from the browser, so a test can stand in for it. */
export interface ClipboardHost {
  writeText?: (text: string) => Promise<void>;
  execCopy?: (text: string) => boolean;
}

/** True once the text is on the clipboard; false when the browser refused both ways. */
export async function copyText(text: string, host: ClipboardHost = browserHost()): Promise<boolean> {
  if (host.writeText) {
    try {
      await host.writeText(text);
      return true;
    } catch {
      // Refused, most likely by the frame's permissions. The fallback below may not be.
    }
  }
  try {
    return host.execCopy?.(text) ?? false;
  } catch {
    return false;
  }
}

function browserHost(): ClipboardHost {
  if (typeof document === "undefined") return {};
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;

  return {
    writeText: clipboard ? (text) => clipboard.writeText(text) : undefined,
    execCopy: (text) => {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        return document.execCommand("copy");
      } finally {
        area.remove();
      }
    },
  };
}
