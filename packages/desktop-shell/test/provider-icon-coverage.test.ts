import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { bundledProviderIds } from "../../../src/providers/bundled.js";
import { ProviderIcon, providerIconMonogram } from "../src/renderer/providers/ProviderIcon.js";
import { providerIconDefinitions } from "../src/renderer/providers/provider-icons.js";

describe("provider card icon coverage", () => {
  it("renders current Pi and bundled Providers, using the existing fallback for new brands", () => {
    const shipped = [
      ...builtinProviders().map(({ id, name }) => ({ providerId: id, name })),
      ...[...bundledProviderIds].map((id) => ({ providerId: id, name: id })),
      { providerId: "future-pi-provider", name: "Future Provider" },
    ];
    expect(shipped.length).toBeGreaterThan(0);
    for (const props of shipped) {
      const markup = renderToStaticMarkup(createElement(ProviderIcon, props));
      expect(markup).toContain('class="provider-icon');
      expect(markup).toContain('aria-hidden="true"');
      if (providerIconDefinitions[props.providerId] === undefined) {
        expect(markup).toContain('data-provider-icon="fallback"');
        expect(markup).toContain(`>${providerIconMonogram(props.providerId, props.name)}</span>`);
      } else {
        expect(markup).toContain("<svg");
      }
    }
  });
});
