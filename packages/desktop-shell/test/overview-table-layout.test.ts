import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const stylesheetPath = resolve(import.meta.dirname, "../src/renderer/renderer.css");

describe("Overview request table layout", () => {
  it("uses content-driven column sizing instead of fixed table and nth-child widths", async () => {
    const css = await readFile(stylesheetPath, "utf8");
    const tableRule = css.match(/\.overview-request-table\s*\{[^}]*\}/u)?.[0] ?? "";

    expect(tableRule).toContain("table-layout: auto");
    expect(tableRule).toContain("width: max-content");
    expect(tableRule).toContain("min-width: 100%");
    expect(tableRule).not.toContain("min-width: 1540px");
    expect(css).not.toMatch(/\.overview-request-table th:nth-child\(/u);
    expect(css).toMatch(/\.overview-col-compact\s*\{[^}]*width:\s*1%/u);
    expect(css).not.toContain("overview-col-project");
  });
});
