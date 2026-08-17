// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AliasCommand,
  AliasCommandResult,
  CatalogCommand,
  CatalogCommandResult,
  ModelsCommand,
  ModelsCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

import { ModelsFileWorkspace } from "../src/models-editors.js";

/**
 * Ticket 14 UI seam: the Aliases tab of Models & Aliases shows every known
 * model with availability, effective alias, source layer and validation
 * errors (all derived from the authoritative projections), keeps unmapped
 * models manageable, and drives the structured user mapping editor through
 * the compare-and-swap alias commands.
 */

const path = "C:\\models.json";

const modelsState: ModelsCommandResult = {
  outcome: "ok",
  state: {
    revision: 1,
    path,
    present: true,
    valid: true,
    raw: "{}\n",
    providers: {},
    catalog: {
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
          layer: "builtin",
          models: [
            {
              id: "gpt-4o",
              name: "GPT-4o",
              api: "openai-completions",
              provider: "openai",
              baseUrl: "https://api.openai.com/v1",
              reasoning: false,
              input: ["text"],
              cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
              contextWindow: 128000,
              maxTokens: 4096,
              layer: "builtin",
            },
            {
              id: "gpt-4o-mini",
              name: "GPT-4o mini",
              api: "openai-completions",
              provider: "openai",
              baseUrl: "https://api.openai.com/v1",
              reasoning: false,
              input: ["text"],
              cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
              contextWindow: 128000,
              maxTokens: 4096,
              layer: "builtin",
            },
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              api: "openai-completions",
              provider: "openai",
              baseUrl: "https://api.openai.com/v1",
              reasoning: true,
              input: ["text"],
              cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
              contextWindow: 400000,
              maxTokens: 16384,
              layer: "builtin",
            },
          ],
        },
      ],
      compositionErrors: [],
    },
  },
};

const catalogResult: CatalogCommandResult = {
  outcome: "ok",
  snapshot: {
    version: 4,
    modelsJsonValid: true,
    providers: [
      {
        providerId: "openai",
        name: "OpenAI",
        dynamic: false,
        state: "known",
        models: [
          { id: "gpt-4o", dynamic: false, availability: "available" },
          { id: "gpt-4o-mini", dynamic: false, availability: "unavailable" },
          { id: "gpt-5.4", dynamic: false, availability: "available" },
        ],
      },
    ],
    refreshErrors: [],
  },
};

function aliasState(overrides?: Partial<AliasCommandResult["state"]>): AliasCommandResult {
  return {
    outcome: "ok",
    state: {
      revision: 2,
      path: "C:\\model-aliases.json",
      present: true,
      valid: true,
      raw: "{}\n",
      defaultsVersion: 1,
      catalogVersion: 4,
      aliases: {
        "my-gpt": { provider: "openai", model: "gpt-4o" },
      },
      effective: {
        defaultsVersion: 1,
        aliases: [
          {
            alias: "my-gpt",
            target: { provider: "openai", model: "gpt-4o" },
            layer: "user",
          },
          {
            alias: "gpt-4o",
            target: { provider: "openai", model: "gpt-4o-mini" },
            layer: "default",
          },
        ],
        errors: [
          {
            alias: "broken",
            code: "unknown",
            message: 'Target "openai/missing" of alias "broken" is not in the active catalog.',
          },
        ],
      },
      ...(overrides === undefined ? {} : overrides),
    },
  };
}

describe("alias registry workspace seam", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function renderWorkspace(options: {
    readonly onAliasCommand: (command: AliasCommand) => void;
    readonly aliasResult?: AliasCommandResult;
    readonly aliasProjection?: AliasCommandResult["state"] extends never
      ? never
      : { revision: number; path: string; present: boolean; valid: boolean; defaultsVersion: number };
  }) {
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          aliasBusy={false}
          busy={false}
          mode="models"
          onAliasCommand={options.onAliasCommand}
          onCatalogCommand={() => undefined}
          onCommand={() => undefined}
          onReload={() => undefined}
          projection={{ revision: 1, path, present: true, valid: true }}
          result={modelsState}
          {...(options.aliasResult === undefined
            ? {}
            : { aliasResult: options.aliasResult })}
          {...(options.aliasProjection === undefined
            ? {}
            : { aliasProjection: options.aliasProjection })}
          {...(catalogResult === undefined ? {} : { catalogResult })}
        />,
      );
    });
    // Open the Aliases tab.
    await act(async () => {
      const buttons = [...container.querySelectorAll("button")];
      const aliases = buttons.find(
        (button) => button.textContent?.trim() === "Aliases",
      );
      aliases?.click();
    });
  }

  it("shows every known model with availability, effective alias and source layer", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
      aliasResult: aliasState(),
    });
    const rows = [...container.querySelectorAll(".alias-model-row")];
    expect(rows).toHaveLength(3);
    const gpt4o = rows.find((row) => row.textContent?.includes("gpt-4o"));
    expect(gpt4o?.textContent).toContain("available");
    expect(gpt4o?.textContent).toContain("my-gpt");
    expect(gpt4o?.textContent).toContain("user mapping");
    const mini = rows.find((row) => row.textContent?.includes("gpt-4o-mini"));
    expect(mini?.textContent).toContain("unavailable");
    expect(mini?.textContent).toContain("gpt-4o");
    expect(mini?.textContent).toContain("curated default");
  });

  it("keeps unmapped models manageable with an Add alias action", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
      aliasResult: aliasState(),
    });
    // gpt-5.4 has no alias: it stays visible and manageable.
    const unmapped = [...container.querySelectorAll(".alias-model-row")].find(
      (row) => row.textContent?.includes("gpt-5.4"),
    );
    expect(unmapped?.textContent).toContain("no alias");
    expect(unmapped?.textContent).toContain("available");
    // Seeding the editor from an unmapped model is one click.
    const add = [...(unmapped?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Add alias",
    );
    await act(async () => {
      add?.click();
    });
    const inputs = [...container.querySelectorAll(".alias-editor-row input")];
    const aliasValues = inputs.map((input) => (input as HTMLInputElement).value);
    // The seeded user mapping plus the newly added unmapped model entry.
    expect(aliasValues.filter((value) => value === "gpt-5.4").length).toBe(2);
    expect(aliasValues).toContain("openai");
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save user mappings",
    );
    await act(async () => {
      save?.click();
    });
    const write = commands.find((command) => command.command === "write");
    expect(write).toBeDefined();
    if (write?.command !== "write") return;
    expect(write.revision).toBe(2);
    expect(write.aliases).toEqual({
      "my-gpt": { provider: "openai", model: "gpt-4o" },
      "gpt-5.4": { provider: "openai", model: "gpt-5.4" },
    });
  });

  it("shows the authoritative validation errors", async () => {
    await renderWorkspace({
      onAliasCommand: () => undefined,
      aliasResult: aliasState(),
    });
    const errors = [...container.querySelectorAll(".models-error")].find(
      (panel) => panel.textContent?.includes("Alias validation errors"),
    );
    expect(errors?.textContent).toContain("broken");
    expect(errors?.textContent).toContain("unknown target");
  });

  it("saves the user mapping draft with the bound revision (compare-and-swap)", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
      aliasResult: aliasState(),
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save user mappings",
    );
    await act(async () => {
      save?.click();
    });
    const write = commands.find((command) => command.command === "write");
    expect(write).toBeDefined();
    if (write?.command !== "write") return;
    expect(write.revision).toBe(2);
    expect(write.aliases).toEqual({
      "my-gpt": { provider: "openai", model: "gpt-4o" },
    });
  });

  it("shows a conflict banner and keeps the draft on a stale revision", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
      aliasResult: aliasState(),
    });
    // The authoritative revision moves (external write / another client)
    // and the save comes back as a conflict.
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          aliasBusy={false}
          busy={false}
          mode="models"
          onAliasCommand={(command) => commands.push(command)}
          onCatalogCommand={() => undefined}
          onCommand={() => undefined}
          onReload={() => undefined}
          projection={{ revision: 1, path, present: true, valid: true }}
          result={modelsState}
          aliasResult={{
            outcome: "conflict",
            state: {
              revision: 3,
              path: "C:\\model-aliases.json",
              present: true,
              valid: true,
              raw: "{}\n",
              defaultsVersion: 1,
              catalogVersion: 4,
              aliases: {},
              effective: {
                defaultsVersion: 1,
                aliases: [],
                errors: [],
              },
            },
          }}
          catalogResult={catalogResult}
        />,
      );
    });
    expect(container.textContent).toContain("Draft is based on revision 2");
    expect(container.textContent).toContain("Reload (discard draft)");
    // The draft survives: the editor still carries the pre-conflict rows.
    const aliasInputs = container.querySelectorAll(".alias-editor-row input");
    expect(aliasInputs.length).toBeGreaterThan(0);
  });

  it("submits the draft's original revision again after a conflict", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
      aliasResult: aliasState(),
    });
    // First save of the draft bound to revision 2.
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save user mappings",
    );
    await act(async () => {
      save?.click();
    });
    const firstWrite = commands.find((command) => command.command === "write");
    if (firstWrite?.command !== "write") throw new Error("first save must write");
    expect(firstWrite.revision).toBe(2);

    // The save comes back as a conflict: the file moved to revision 3
    // elsewhere and the draft is retained on its bound revision 2.
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          aliasBusy={false}
          busy={false}
          mode="models"
          onAliasCommand={(command) => commands.push(command)}
          onCatalogCommand={() => undefined}
          onCommand={() => undefined}
          onReload={() => undefined}
          projection={{ revision: 1, path, present: true, valid: true }}
          result={modelsState}
          aliasResult={{
            outcome: "conflict",
            state: {
              revision: 3,
              path: "C:\\model-aliases.json",
              present: true,
              valid: true,
              raw: "{}\n",
              defaultsVersion: 1,
              catalogVersion: 4,
              aliases: {},
              effective: {
                defaultsVersion: 1,
                aliases: [],
                errors: [],
              },
            },
          }}
          catalogResult={catalogResult}
        />,
      );
    });
    expect(container.textContent).toContain("Draft is based on revision 2");

    // A second save of the unchanged stale draft must still submit its
    // original revision 2 — never the newer served state revision 3 — so
    // the Control Plane CAS rejects it again instead of overwriting the
    // external edit.
    const saveAgain = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save user mappings",
    );
    await act(async () => {
      saveAgain?.click();
    });
    const writes = commands.filter((command) => command.command === "write");
    expect(writes).toHaveLength(2);
    const secondWrite = writes[1];
    if (secondWrite?.command !== "write") return;
    expect(secondWrite.revision).toBe(2);
    expect(secondWrite.revision).not.toBe(3);
  });

  it("never overwrites a draft entry that already uses the alias for another model", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
      aliasResult: aliasState(),
    });
    // Seed a draft entry whose alias name collides with the unmapped model
    // gpt-5.4 but targets a different model.
    const addRow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "+ Add alias",
    );
    await act(async () => {
      addRow?.click();
    });
    const setRowInput = (label: string, from: string, value: string) => {
      const input = [
        ...container.querySelectorAll<HTMLInputElement>(".alias-editor-row input"),
      ].find(
        (candidate) =>
          candidate.getAttribute("aria-label") === label && candidate.value === from,
      );
      expect(input).toBeDefined();
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      expect(setter).toBeDefined();
      return act(async () => {
        if (input === undefined || setter === undefined) return;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await setRowInput("alias name", "new-alias", "gpt-5.4");
    await setRowInput("provider id", "", "anthropic");
    await setRowInput("model id", "", "claude-x");

    // The unmapped gpt-5.4 row must refuse to clobber: its Add alias action
    // is visibly disabled while the draft owns the alias for another model.
    const unmapped = [...container.querySelectorAll(".alias-model-row")].find(
      (row) => row.textContent?.includes("gpt-5.4"),
    );
    const add = [...(unmapped?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Add alias",
    );
    expect((add as HTMLButtonElement | undefined)?.disabled).toBe(true);

    // The draft entry survives untouched through a save.
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save user mappings",
    );
    await act(async () => {
      save?.click();
    });
    const write = commands.find((command) => command.command === "write");
    expect(write).toBeDefined();
    if (write?.command !== "write") return;
    expect(write.aliases["gpt-5.4"]).toEqual({
      provider: "anthropic",
      model: "claude-x",
    });
    expect(write.aliases["my-gpt"]).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("surfaces an external file change through the status projection", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
      aliasResult: aliasState(),
      aliasProjection: {
        revision: 4,
        path: "C:\\model-aliases.json",
        present: true,
        valid: true,
        defaultsVersion: 1,
      },
    });
    expect(container.textContent).toContain("The alias file changed elsewhere");
  });

  it("queries the authoritative alias state when the page opens", async () => {
    const commands: AliasCommand[] = [];
    await renderWorkspace({
      onAliasCommand: (command) => commands.push(command),
    });
    expect(commands.some((command) => command.command === "query")).toBe(true);
  });
});
