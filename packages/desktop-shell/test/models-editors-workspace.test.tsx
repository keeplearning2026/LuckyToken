// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ModelsCommand,
  ModelsCommandResult,
  ModelsFileState,
} from "@luckytoken/application-control-plane/control-plane";

import { ModelsFileWorkspace } from "../src/models-editors.js";

/**
 * Ticket 08 UI adapter seam (repair turn 2): the reload/draft revision race.
 * A save can never carry a revision newer than its draft content, reload
 * re-bases drafts on the fresh query result, and unsaved drafts are never
 * silently replaced or rebased when an external revision arrives.
 */

const path = "C:\\models.json";

function stateAt(
  revision: number,
  raw: string,
  providers: Record<string, unknown>,
): ModelsFileState {
  return {
    revision,
    path,
    present: true,
    valid: true,
    raw,
    providers,
  };
}

const ollamaContent =
  '{ "providers": { "ollama": { "baseUrl": "http://ollama", "api": "openai-completions", "models": [{ "id": "m1" }] } } }';
const ollamaState = (revision: number): ModelsFileState =>
  stateAt(revision, ollamaContent, {
    ollama: {
      baseUrl: "http://ollama",
      api: "openai-completions",
      models: [{ id: "m1" }],
    },
  });

const externalContent =
  '{ "providers": { "external": { "baseUrl": "http://cli", "api": "openai-completions", "models": [{ "id": "cli-model" }] } } }';
const externalState = (revision: number): ModelsFileState =>
  stateAt(revision, externalContent, {
    external: {
      baseUrl: "http://cli",
      api: "openai-completions",
      models: [{ id: "cli-model" }],
    },
  });

function resultOf(state: ModelsFileState): ModelsCommandResult {
  return { outcome: "ok", state };
}

function projectionOf(revision: number): {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
} {
  return { revision, path, present: true, valid: true };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("textarea value setter missing");
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("input value setter missing");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function ollamaProviders(modelId: string): Record<string, unknown> {
  return {
    ollama: {
      baseUrl: "http://ollama",
      api: "openai-completions",
      models: [{ id: modelId }],
    },
  };
}

function ollamaRaw(modelId: string): string {
  return `{ "providers": { "ollama": { "baseUrl": "http://ollama", "api": "openai-completions", "models": [{ "id": "${modelId}" }] } } }`;
}

describe("models workspace reload/draft revision public seam", () => {
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
    readonly result: ModelsCommandResult | undefined;
    readonly projection?: ReturnType<typeof projectionOf>;
  }): Promise<{
    readonly rawEditor: () => HTMLTextAreaElement | null;
    readonly saveButton: () => HTMLButtonElement | null;
    readonly reloadButton: () => HTMLButtonElement | null;
    readonly conflictBanner: () => HTMLElement | null;
  }> {
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          busy={false}
          mode="providers"
          onCommand={(command) => {
            commands.push(command);
          }}
          onReload={() => undefined}
          projection={props.projection}
          result={props.result}
        />,
      );
    });
    return {
      rawEditor: () => container.querySelector<HTMLTextAreaElement>(".models-raw"),
      saveButton: () => container.querySelector<HTMLButtonElement>(".models-save"),
      reloadButton: () =>
        container.querySelector<HTMLButtonElement>(".models-external button"),
      conflictBanner: () =>
        container.querySelector<HTMLElement>(".models-conflict"),
    };
  }

  async function rerender(
    props: {
      readonly result: ModelsCommandResult | undefined;
      readonly projection?: ReturnType<typeof projectionOf>;
    },
  ): Promise<void> {
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          busy={false}
          mode="providers"
          onCommand={(command) => {
            commands.push(command);
          }}
          onReload={() => undefined}
          projection={props.projection}
          result={props.result}
        />,
      );
    });
  }

  function openRawTab(): void {
    const tabs = container.querySelectorAll<HTMLButtonElement>(".models-tabs button");
    act(() => {
      tabs[1]?.click();
    });
  }

  it("reloads both editors from the fresh query result and save cannot restore old content", async () => {
    const first = ollamaState(0);
    const ui = await renderWorkspace({ result: resultOf(first) });
    openRawTab();
    expect(ui.rawEditor()?.value).toBe(ollamaContent);

    // An external CLI write bumps the status revision while the workspace
    // still holds revision 0.
    await rerender({
      result: resultOf(first),
      projection: projectionOf(1),
    });
    const reloadButton = ui.reloadButton();
    expect(reloadButton).not.toBeNull();

    // The user confirms the reload: drafts are discarded and a fresh query
    // is issued. The fresh result (external content, revision 1) arrives.
    let reloadFired = false;
    await act(async () => {
      root.render(
        <ModelsFileWorkspace
          busy={false}
          mode="providers"
          onCommand={(command) => {
            commands.push(command);
          }}
          onReload={() => {
            reloadFired = true;
          }}
          projection={projectionOf(1)}
          result={resultOf(first)}
        />,
      );
    });
    act(() => {
      container
        .querySelector<HTMLButtonElement>(".models-external button")
        ?.click();
    });
    expect(reloadFired).toBe(true);

    // The fresh query result arrives while the drafts are still undefined.
    await rerender({
      result: resultOf(externalState(1)),
      projection: projectionOf(1),
    });

    // The raw editor shows the fresh external content, not the old bytes.
    expect(ui.rawEditor()?.value).toBe(externalContent);
    // The structured editor re-based too: switch back and check the
    // provider id is the fresh one.
    const tabs = container.querySelectorAll<HTMLButtonElement>(
      ".models-tabs button",
    );
    act(() => {
      tabs[0]?.click();
    });
    const providerId = container.querySelector<HTMLInputElement>(
      '.models-card input[type="text"]',
    );
    expect(providerId?.value).toBe("external");

    // Save without modification must not restore the old content: the write
    // carries the fresh revision with the fresh content.
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands).toEqual([
      {
        command: "write_structured",
        revision: 1,
        providers: {
          external: {
            baseUrl: "http://cli",
            api: "openai-completions",
            models: [{ id: "cli-model" }],
          },
        },
      },
    ]);
    expect(JSON.stringify(commands)).not.toContain("ollama");
  });

  it("re-bases both drafts after a successful raw save and the second save carries the new revision", async () => {
    const ui = await renderWorkspace({ result: resultOf(ollamaState(0)) });
    openRawTab();
    const edited = ollamaRaw("m1-saved");
    setTextareaValue(ui.rawEditor() as HTMLTextAreaElement, edited);
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands).toEqual([
      { command: "write_raw", revision: 0, content: edited },
    ]);

    // The save succeeds at revision 1 with exactly the submitted content.
    await rerender({
      result: resultOf(stateAt(1, edited, ollamaProviders("m1-saved"))),
      projection: projectionOf(1),
    });
    // No false stale state after a successful save: neither the conflict
    // nor the stale-draft banner appears.
    expect(container.querySelector(".models-conflict")).toBeNull();

    // Continue editing; the second save submits the new revision and the
    // continuation content, and succeeds without any conflict.
    const continued = ollamaRaw("m1-continued");
    setTextareaValue(ui.rawEditor() as HTMLTextAreaElement, continued);
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands[1]).toEqual({
      command: "write_raw",
      revision: 1,
      content: continued,
    });
    await rerender({
      result: resultOf(stateAt(2, continued, ollamaProviders("m1-continued"))),
      projection: projectionOf(2),
    });
    expect(container.querySelector(".models-conflict")).toBeNull();
  });

  it("re-bases both drafts after a successful structured save and keeps the raw editor coherent", async () => {
    const ui = await renderWorkspace({ result: resultOf(ollamaState(0)) });
    // The structured tab is the default; edit the provider name field.
    const nameInput = container.querySelectorAll<HTMLInputElement>(
      '.models-card input[type="text"]',
    )[1];
    if (nameInput === undefined) throw new Error("name input missing");
    setInputValue(nameInput, "Renamed");
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands[0]).toEqual({
      command: "write_structured",
      revision: 0,
      providers: {
        ollama: {
          baseUrl: "http://ollama",
          api: "openai-completions",
          models: [{ id: "m1" }],
          name: "Renamed",
        },
      },
    });

    // The structured write deterministically normalizes the raw content;
    // the ok result carries that authoritative state.
    const savedProviders = {
      ollama: {
        baseUrl: "http://ollama",
        api: "openai-completions",
        models: [{ id: "m1" }],
        name: "Renamed",
      },
    };
    const normalizedRaw = `${JSON.stringify(
      { providers: savedProviders },
      null,
      2,
    )}\n`;
    await rerender({
      result: resultOf(stateAt(1, normalizedRaw, savedProviders)),
      projection: projectionOf(1),
    });
    expect(container.querySelector(".models-conflict")).toBeNull();

    // The raw editor re-based onto the deterministic normalized content.
    openRawTab();
    expect(ui.rawEditor()?.value).toBe(normalizedRaw);

    // Continue editing on the raw side; the next save carries revision 1.
    const continued = normalizedRaw.replace('"Renamed"', '"Renamed-2"');
    setTextareaValue(ui.rawEditor() as HTMLTextAreaElement, continued);
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands[1]).toEqual({
      command: "write_raw",
      revision: 1,
      content: continued,
    });
  });

  it("preserves edits typed while a save is in flight and still re-bases the revision", async () => {
    const ui = await renderWorkspace({ result: resultOf(ollamaState(0)) });
    openRawTab();
    const submitted = ollamaRaw("m1-saved");
    setTextareaValue(ui.rawEditor() as HTMLTextAreaElement, submitted);
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands[0]).toEqual({
      command: "write_raw",
      revision: 0,
      content: submitted,
    });

    // While the save is in flight the user keeps typing.
    const continued = ollamaRaw("m1-saved-then-edited");
    setTextareaValue(ui.rawEditor() as HTMLTextAreaElement, continued);

    // The ok result arrives: the file holds the submitted content.
    await rerender({
      result: resultOf(stateAt(1, submitted, ollamaProviders("m1-saved"))),
      projection: projectionOf(1),
    });

    // The newer edits are preserved — never silently replaced by the saved
    // bytes — and the draft is re-based onto the new revision.
    expect(ui.rawEditor()?.value).toBe(continued);
    expect(container.querySelector(".models-conflict")).toBeNull();
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands[1]).toEqual({
      command: "write_raw",
      revision: 1,
      content: continued,
    });
  });

  it("keeps an unsaved draft when an external revision arrives and never submits it with the new revision", async () => {
    const ui = await renderWorkspace({ result: resultOf(ollamaState(0)) });
    openRawTab();
    const textarea = ui.rawEditor();
    if (textarea === null) throw new Error("raw editor missing");

    // The user drafts a local edit at revision 0.
    const draftContent = ollamaContent.replace("m1", "m1-local");
    setTextareaValue(textarea, draftContent);

    // An external revision arrives (CLI write), status projection advances.
    await rerender({
      result: resultOf(externalState(1)),
      projection: projectionOf(1),
    });

    // The unsaved draft is preserved verbatim — never silently replaced by
    // the external content and never rebased onto the new revision.
    expect(ui.rawEditor()?.value).toBe(draftContent);
    expect(ui.rawEditor()?.value).not.toBe(externalContent);

    // Saving submits the draft's own base revision, so the CAS rejects it:
    // the old draft can never ride a newer revision to overwrite the CLI
    // edit silently.
    act(() => {
      ui.saveButton()?.click();
    });
    expect(commands).toEqual([
      { command: "write_raw", revision: 0, content: draftContent },
    ]);

    // The explicit conflict result surfaces as the conflict banner.
    await rerender({
      result: {
        outcome: "conflict",
        state: externalState(1),
      },
      projection: projectionOf(1),
    });
    expect(ui.conflictBanner()).not.toBeNull();
    // The draft survives the conflict for the user to resolve.
    expect(ui.rawEditor()?.value).toBe(draftContent);
  });
});
