import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const stylesheetPath = resolve(import.meta.dirname, "../src/renderer/renderer.css");

describe("Overview request table layout", () => {
  it("uses a fixed table layout without fragile nth-child widths", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    const tableRule = css.match(/\.overview-request-table\s*\{[^}]*\}/u)?.[0] ?? "";

    expect(tableRule).toContain("table-layout: fixed");
    expect(tableRule).toContain("min-width: 100%");
    expect(tableRule).not.toContain("min-width: 1540px");
    expect(css).not.toMatch(/\.overview-request-table th:nth-child\(/u);
    expect(css).toMatch(/\.column-resize-handle\s*\{[^}]*cursor:\s*col-resize/u);
    expect(css).not.toContain("overview-col-project");
  });
});
