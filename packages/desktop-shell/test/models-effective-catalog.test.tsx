// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  EffectiveCatalogProjection,
  ModelsCommand,
  ModelsCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import { ModelsFileWorkspace } from "../src/models-editors.js";

/**
 * Ticket 09 UI seam: the Providers and Models & Aliases pages render the
 * effective catalog from the Control Plane state (never a second registry)
 * and distinguish the built-in / user / overridden source layers.
 */

const path = "C:\\models.json";

const catalogFixture: EffectiveCatalogProjection = {
  schemaVersion: "luckytoken-effective-catalog-v1",
  baseline: {
    package: "@earendil-works/pi-coding-agent",
    version: "0.84.1",
    schema: "pi-coding-agent-0.84.1-models-json-schema",
  },
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      layer: "builtin",
      models: [
        {
          id: "gpt-4",
          name: "GPT-4",
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 8192,
          layer: "builtin",
        },
        {
          id: "gpt-5",
          name: "GPT-5 via Gateway",
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://gateway.example.com/v1",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
          contextWindow: 400000,
          maxTokens: 128000,
          layer: "overridden",
          overriddenFields: ["name", "baseUrl"],
        },
      ],
    },
    {
      id: "my-gateway",
      name: "my-gateway",
      baseUrl: "https://gateway.example.com/v1",
      layer: "user",
      models: [
        {
          id: "m-1",
          name: "m-1",
          api: "openai-completions",
          provider: "my-gateway",
          baseUrl: "https://gateway.example.com/v1",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
          layer: "user",
        },
      ],
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      layer: "overlaid",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "deepseek-v4-flash",
          api: "openai-completions",
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 16384,
          layer: "upserted",
        },
      ],
    },
  ],
  compositionErrors: [
    {
      providerId: "broken",
      message: 'Provider broken, model m: no "api" specified. Set at provider or model level.',
    },
  ],
};

function resultOf(
  catalog: EffectiveCatalogProjection | undefined,
  valid: boolean,
  present: boolean,
): ModelsCommandResult {
  return {
    outcome: "ok",
    state: {
      revision: 1,
      path,
      present,
      valid,
      raw: valid ? "{}" : "broken",
      ...(valid ? { providers: {} } : {}),
      ...(valid && catalog !== undefined ? { catalog } : {}),
      ...(valid
        ? {}
        : { error: { kind: "parse", message: "models.json is not loadable" } }),
    },
  };
}

describe("effective catalog page seam", () => {
  let container: HTMLDivElement;
  let root: Root;
  let commands: ModelsCommand[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    commands = [];
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderWorkspace(props: {
    readonly mode: "providers" | "models";
    readonly result: ModelsCommandResult;
  }): Promise<void> {
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          busy={false}
          mode={props.mode}
          onCommand={(command) => {
            commands.push(command);
          }}
          onReload={() => undefined}
          projection={undefined}
          result={props.result}
        />,
      );
    });
  }

  function openEffectiveTab(): void {
    const tabs = container.querySelectorAll<HTMLButtonElement>(
      ".models-tabs button",
    );
    act(() => {
      tabs[2]?.click();
    });
  }

  function badges(): string[] {
    return [...container.querySelectorAll<HTMLElement>(".effective-badge")].map(
      (badge) => badge.textContent ?? "",
    );
  }

  it("shows the effective providers with built-in/user/overlaid layer badges", async () => {
    await renderWorkspace({
      mode: "providers",
      result: resultOf(catalogFixture, true, true),
    });
    openEffectiveTab();

    const cards = container.querySelectorAll<HTMLElement>(
      ".effective-provider",
    );
    expect(cards.length).toBe(3);
    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).toContain("my-gateway");
    expect(container.textContent).toContain("DeepSeek");
    // Provider source layers: built-in, user-defined, built-in + overlay.
    expect(badges()).toContain("built-in");
    expect(badges()).toContain("user-defined");
    expect(badges()).toContain("built-in + overlay");
    // Model layers: untouched built-in, overridden, user-defined, upserted.
    expect(badges()).toContain("user-upserted");
    expect(badges()).toContain("overridden");
    // The pinned baseline is identified for the page.
    expect(container.textContent).toContain("0.84.1");
    // Composition failures surface as a visible alert with the pinned error.
    const alert = container.querySelector<HTMLElement>(".effective-errors");
    expect(alert?.textContent).toContain("broken");
    expect(alert?.textContent).toContain(
      'Provider broken, model m: no "api" specified',
    );
  });

  it("renders the effective model facts and never a credentials field", async () => {
    await renderWorkspace({
      mode: "models",
      result: resultOf(catalogFixture, true, true),
    });
    openEffectiveTab();

    const text = container.textContent ?? "";
    expect(text).toContain("gpt-4");
    expect(text).toContain("openai-responses");
    expect(text).toContain("https://api.openai.com/v1");
    expect(text).toContain("8192");
    expect(text).toContain("GPT-5 via Gateway");
    expect(text).toContain("overridden");
    expect(text).toContain("deepseek-v4-flash");
    expect(text).toContain("user-upserted");
    // The catalog DTO never carries credential fields to render.
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("Authorization");
  });

  it("keeps the editor tabs intact and shows the catalog note while the file is invalid", async () => {
    await renderWorkspace({
      mode: "providers",
      result: resultOf(undefined, false, true),
    });
    openEffectiveTab();
    // The loadability error panel stays the authoritative error surface.
    expect(container.textContent).toContain("models.json is not loadable");
    // The effective tab never guesses a catalog from an invalid file.
    expect(container.querySelector(".effective-provider")).toBeNull();
    // The structured editor still renders (Ticket 08 preserved).
    const tabs = container.querySelectorAll<HTMLButtonElement>(
      ".models-tabs button",
    );
    act(() => {
      tabs[0]?.click();
    });
    expect(container.querySelector(".models-save")).not.toBeNull();
  });
});
