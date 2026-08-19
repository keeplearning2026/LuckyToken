import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const stylesheetPath = resolve(import.meta.dirname, "../src/renderer/renderer.css");

describe("Providers models modal layout", () => {
  it("keeps the header/close action outside the scrolling model body", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    const modalRule = css.match(/\.models-modal\s*\{[^}]*\}/u)?.[0] ?? "";
    const bodyRule = css.match(/\.models-modal-body\s*\{[^}]*\}/u)?.[0] ?? "";

    expect(modalRule).toContain("overflow: hidden");
    expect(modalRule).toContain("grid-template-rows: auto minmax(0, 1fr)");
    expect(bodyRule).toContain("overflow-y: auto");
    expect(css).toMatch(/\.models-modal \.task-modal-header\s*\{[^}]*z-index:\s*2/u);
  });
});
