import { describe, expect, it, vi } from "vitest";

import { createManagementWindowLifecycle } from "../src/main/management-window-lifecycle.js";

describe("management window lifecycle seam", () => {
  it("destroys the current window and creates a fresh one when reopened", () => {
    const destroyFirst = vi.fn();
    const focusFirst = vi.fn();
    const destroySecond = vi.fn();
    const focusSecond = vi.fn();
    const windows = [
      { destroy: destroyFirst, focus: focusFirst },
      { destroy: destroySecond, focus: focusSecond },
    ];
    const createWindow = vi.fn(() => {
      const window = windows.shift();
      if (window === undefined) throw new Error("unexpected extra window");
      return window;
    });
    const lifecycle = createManagementWindowLifecycle({ createWindow });

    lifecycle.open();
    lifecycle.open();
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(focusFirst).toHaveBeenCalledTimes(1);

    lifecycle.close();
    expect(destroyFirst).toHaveBeenCalledTimes(1);
    expect(lifecycle.isOpen()).toBe(false);

    lifecycle.open();
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(lifecycle.isOpen()).toBe(true);
    expect(destroySecond).not.toHaveBeenCalled();
  });
});
