// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderIcon, providerIconMonogram } from "../src/renderer/providers/ProviderIcon.js";
import { providerIconDefinitions } from "../src/renderer/providers/provider-icons.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderIcon(providerId: string, name: string): Promise<void> {
  await act(async () => {
    root.render(<ProviderIcon providerId={providerId} name={name} />);
    await Promise.resolve();
  });
}

describe("ProviderIcon", () => {
  it("renders every vendored brand glyph on the 24x24 source grid", async () => {
    for (const [providerId, definition] of Object.entries(providerIconDefinitions)) {
      await renderIcon(providerId, definition.title);
      const icon = container.querySelector(`[data-provider-icon="${providerId}"]`);
      const svg = icon?.querySelector("svg");
      expect(svg?.getAttribute("viewBox"), providerId).toBe("0 0 24 24");
      const paths = [...(svg?.querySelectorAll("path") ?? [])];
      expect(paths.length, providerId).toBe(definition.paths.length);
      expect(paths.length, providerId).toBeGreaterThan(0);
      for (const path of paths) {
        expect(path.getAttribute("d")?.length, providerId).toBeGreaterThan(0);
        expect(path.getAttribute("fill"), providerId).toBe("currentColor");
      }
    }
  });

  it("falls back to a monogram tile for a Provider without a brand glyph", async () => {
    await renderIcon("custom-gateway", "Custom Gateway");
    const icon = container.querySelector('[data-provider-icon="fallback"]');
    expect(icon?.textContent).toBe("C");
    expect(icon?.querySelector("svg")).toBeNull();
  });

  it("keeps the fallback bounded for unusual Provider identities", async () => {
    expect(providerIconMonogram("custom-gateway", "Custom Gateway")).toBe("C");
    expect(providerIconMonogram("custom-gateway", "  ·· custom")).toBe("C");
    expect(providerIconMonogram("123tool", "   ")).toBe("1");
    expect(providerIconMonogram("", "")).toBe("?");
  });
});
