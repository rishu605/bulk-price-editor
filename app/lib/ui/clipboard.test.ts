/**
 * Copying from inside the admin's iframe, where the standard way may be refused (#826).
 */

import { describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

describe("copyText", () => {
  it("uses the Clipboard API when the frame allows it", async () => {
    const writeText = vi.fn(async () => {});
    const execCopy = vi.fn(() => true);

    expect(await copyText("cm123", { writeText, execCopy })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("cm123");
    expect(execCopy).not.toHaveBeenCalled();
  });

  it("falls back to the older copy when the Clipboard API is refused", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("Write permission denied.", "NotAllowedError");
    });
    const execCopy = vi.fn(() => true);

    expect(await copyText("cm123", { writeText, execCopy })).toBe(true);
    expect(execCopy).toHaveBeenCalledWith("cm123");
  });

  it("says so when both are refused, so the caller can tell the merchant", async () => {
    const writeText = async () => {
      throw new Error("denied");
    };
    expect(await copyText("cm123", { writeText, execCopy: () => false })).toBe(false);
    expect(
      await copyText("cm123", {
        execCopy: () => {
          throw new Error("not supported");
        },
      }),
    ).toBe(false);
  });

  it("reports false outside a browser rather than throwing", async () => {
    expect(await copyText("cm123")).toBe(false);
  });
});
