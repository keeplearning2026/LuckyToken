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

  it("renders Profile actions as a separate tall vertical tertiary card", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    const modalRule = css.match(/\.profile-actions-modal\s*\{[^}]*\}/u)?.[0] ?? "";
    const listRule = css.match(/\.profile-actions-list\s*\{[^}]*\}/u)?.[0] ?? "";

    expect(modalRule).toContain("width: min(390px, 100%)");
    expect(modalRule).toContain("min-height: 480px");
    expect(listRule).toContain("grid-template-columns: 1fr");
    expect(css).not.toContain(".profile-actions-card");
    expect(css).not.toMatch(/\.profile-menu\s*\{[^}]*position:\s*absolute/u);
  });

  it("adds only a matching pale tint around the selected three-color navigation strip", async () => {
    const css = await readFile(stylesheetPath, "utf8");

    expect(css).toMatch(/\.color-nav-button\.red\.active\s*\{[^}]*background:\s*rgb\(239 32 41 \/ 8%\)/u);
    expect(css).toMatch(/\.color-nav-button\.yellow\.active\s*\{[^}]*background:\s*rgb\(244 160 0 \/ 10%\)/u);
    expect(css).toMatch(/\.color-nav-button\.blue\.active\s*\{[^}]*background:\s*rgb\(49 150 232 \/ 8%\)/u);
  });
});
