// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/renderer/app/App.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;

const providerStatus = (overrides: Record<string, unknown> = {}) => ({
  providerId: "example",
  stored: true,
  storedType: "oauth" as const,
  environment: false,
  modelsJson: false,
  commandDerived: false,
  expired: false,
  unavailable: false,
  effectiveSource: "stored" as const,
  ...overrides,
});

const authQuery = (overrides: Record<string, unknown> = {}) => ({
  outcome: "ok" as const,
  state: {
    revision: 1,
    path: "auth.json",
    present: true,
    valid: true,
    providers: [providerStatus(overrides)],
  },
  options: {
    providers: [
      {
        providerId: "example",
        name: "Example AI",
        source: "pi_builtin" as const,
        account: true,
        subscription: true,
        accountLabel: "Use Example account",
        apiKey: true,
        apiKeyLabel: "Use API key",
        status: providerStatus(overrides),
      },
    ],
  },
});

type ProviderRow = {
  readonly providerId: string;
  readonly name: string;
  readonly source: "pi_builtin" | "luckytoken_bundled" | "user";
  readonly account?: boolean;
  readonly apiKey?: boolean;
  readonly stored?: boolean;
  readonly unavailable?: boolean;
  readonly expired?: boolean;
  readonly effectiveSource?: "stored" | "environment" | "modelsJson" | "command" | "none";
};

const authQueryMulti = (providers: readonly ProviderRow[]) => ({
  outcome: "ok" as const,
  state: {
    revision: 1,
    path: "auth.json",
    present: true,
    valid: true,
    providers: providers.map((row) => providerStatus(row)),
  },
  options: {
    providers: providers.map((row) => ({
      providerId: row.providerId,
      name: row.name,
      source: row.source,
      account: row.account ?? false,
      subscription: false,
      apiKey: row.apiKey ?? true,
      status: providerStatus(row),
    })),
  },
});

const catalogQueryFor = (providers: readonly {
  readonly providerId: string;
  readonly name: string;
  readonly state?: "known" | "cached" | "refreshing" | "succeeded" | "failed";
  readonly models?: readonly {
    readonly id: string;
    readonly dynamic: boolean;
    readonly availability: "available" | "unavailable" | "unknown";
  }[];
}[]) => ({
  outcome: "ok" as const,
  snapshot: {
    version: 1,
    modelsJsonValid: true,
    providers: providers.map((provider) => ({
      providerId: provider.providerId,
      name: provider.name,
      dynamic: true,
      state: provider.state ?? "succeeded",
      models: provider.models ?? [
        { id: "model-a", dynamic: true, availability: "available" as const },
      ],
    })),
    refreshErrors: [],
  },
});

const catalogQuery = () =>
  catalogQueryFor([
    {
      providerId: "example",
      name: "Example AI",
      models: [
        { id: "model-a", dynamic: true, availability: "available" as const },
        { id: "model-b", dynamic: true, availability: "available" as const },
      ],
    },
  ]);

const publicModelsState = (overrides: Record<string, unknown> = {}) => ({
  outcome: "ok" as const,
  state: {
    revision: 0,
    version: 1,
    endpoint: { host: "127.0.0.1", port: 3000 },
    providers: [
      {
        providerId: "example",
        on: true,
        models: [
          { alias: "example/model-a", target: "model-a", on: true },
          { alias: "example/flash", target: "model-b", on: false },
        ],
      },
    ],
  },
  ...overrides,
});

const aliasState = (overrides: Record<string, unknown> = {}) => ({
  outcome: "ok" as const,
  state: {
    revision: 0,
    path: "model-aliases.json",
    present: false,
    valid: false,
    raw: "",
    catalogVersion: 1,
    effective: {
      aliases: [
        {
          alias: "example/model-a",
          target: { provider: "example", model: "model-a" },
          layer: "default" as const,
        },
        {
          alias: "example/flash",
          target: { provider: "example", model: "model-b" },
          layer: "user" as const,
        },
      ],
      errors: [],
    },
  },
  ...overrides,
});

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

async function render(api: ReturnType<typeof createFakeDesktopApi>): Promise<void> {
  await act(async () => root.render(<App api={api} />));
  await act(async () => {
    const button = container.querySelector('button[aria-label="Providers"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("Providers color bar missing");
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === name,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
  return found;
}

async function click(name: string): Promise<void> {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Providers product slice", () => {
  it("shows Provider auth methods directly and never exposes implementation package names", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
      }),
    );

    expect(container.textContent).toContain("Example AI");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("API key");
    expect(container.textContent).toContain("Auth");
    expect(container.textContent).toContain("Models 2");
    expect(container.textContent).not.toContain("model-aliases.json");
  });

  it("filters Provider cards by search without inventing Provider-specific UI", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () =>
            authQueryMulti([
              { providerId: "anthropic", name: "Anthropic", source: "pi_builtin", unavailable: true, effectiveSource: "none" },
              { providerId: "openai", name: "OpenAI", source: "pi_builtin", unavailable: true, effectiveSource: "none" },
            ]),
          executeCatalog: async () =>
            catalogQueryFor([
              { providerId: "anthropic", name: "Anthropic" },
              { providerId: "openai", name: "OpenAI" },
            ]),
          executeAliases: async () => aliasState(),
        },
      }),
    );

    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) throw new Error("search input missing");
    await act(async () => setInput(search, "anthrop"));
    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).not.toContain("OpenAI");
  });

  it("opens an API-key card, submits the typed secret prompt, and keeps the card until the user closes it", async () => {
    const respondAuth = vi.fn(async () => undefined);
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") {
        return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      }
      listener?.({
        type: "prompt",
        promptId: "prompt-api-key",
        kind: "secret",
        message: "Enter the API key",
        placeholder: "sk-…",
      });
      return new Promise<ReturnType<typeof authQuery>>((resolve) => {
        loginResolve = resolve;
      });
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          respondAuth,
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
      }),
    );

    await click("API key");
    const dialog = container.querySelector('[role="dialog"][aria-label="Example AI sign in"]');
    expect(dialog).not.toBeNull();
    const input = dialog?.querySelector('input[type="password"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("API key input missing");
    await act(async () => setInput(input, "sk-test"));
    await click("Continue");
    expect(respondAuth).toHaveBeenCalledWith({
      type: "prompt_response",
      promptId: "prompt-api-key",
      value: "sk-test",
    });

    await act(async () => loginResolve?.(authQuery()));
    expect(dialog?.textContent).toContain("Connected");
    expect(container.querySelector('[role="dialog"][aria-label="Example AI sign in"]')).not.toBeNull();
    await click("Close");
    expect(container.querySelector('[role="dialog"][aria-label="Example AI sign in"]')).toBeNull();
  });

  it("Auth opens the Pi auth URL immediately and keeps manual-code fallback in the status card", async () => {
    const openExternal = vi.fn(async () => undefined);
    const respondAuth = vi.fn(async () => undefined);
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") {
        return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      }
      listener?.({
        type: "auth_url",
        url: "https://example.com/authorize?state=abc",
        instructions: "Authorize LuckyToken in your browser",
      });
      listener?.({
        type: "prompt",
        promptId: "oauth-manual-code",
        kind: "manual_code",
        message: "Paste the authorization code or redirect URL",
        placeholder: "http://localhost/callback",
      });
      return new Promise<ReturnType<typeof authQuery>>((resolve) => {
        loginResolve = resolve;
      });
    });

    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          respondAuth,
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
        platform: { openExternal },
      }),
    );

    await click("Auth");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/authorize?state=abc");
    expect(container.textContent).toContain("Authorize LuckyToken in your browser");
    expect(container.textContent).toContain("Paste the authorization code or redirect URL");
    expect(container.textContent).not.toContain("https://example.com/authorize?state=abc");
    await click("Open browser again");
    expect(openExternal).toHaveBeenCalledTimes(2);
    await act(async () => loginResolve?.(authQuery()));
  });

  it("device-code auth opens the verification page immediately and shows the code", async () => {
    const openExternal = vi.fn(async () => undefined);
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      listener?.({
        type: "device_code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.com/device",
        intervalSeconds: 5,
        expiresInSeconds: 600,
      });
      return new Promise<ReturnType<typeof authQuery>>((resolve) => {
        loginResolve = resolve;
      });
    });

    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
        platform: { openExternal },
      }),
    );

    await click("Auth");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/device");
    expect(container.textContent).toContain("ABCD-EFGH");
    await act(async () => loginResolve?.(authQuery()));
  });

  it("renders Provider-owned select prompts generically inside the auth card", async () => {
    const respondAuth = vi.fn(async () => undefined);
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      listener?.({
        type: "prompt",
        promptId: "prompt-select",
        kind: "select",
        message: "Choose an account",
        options: [
          { id: "acct-1", label: "Account One" },
          { id: "acct-2", label: "Account Two" },
        ],
      });
      return new Promise<ReturnType<typeof authQuery>>((resolve) => {
        loginResolve = resolve;
      });
    });

    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          respondAuth,
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
      }),
    );
    await click("Auth");
    const select = container.querySelector(".auth-interaction select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("select missing");
    await act(async () => {
      select.value = "acct-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Continue");
    expect(respondAuth).toHaveBeenCalledWith({
      type: "prompt_response",
      promptId: "prompt-select",
      value: "acct-2",
    });
    await act(async () => loginResolve?.(authQuery()));
  });

  it("opens a Provider-scoped Models card and keeps internal alias terminology out of the UI", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
      }),
    );

    expect(container.textContent).not.toContain("model-a");
    await click("Models 2");
    const dialog = container.querySelector('[role="dialog"][aria-label="Example AI models"]');
    expect(dialog?.textContent).toContain("model-a");
    expect(dialog?.textContent).toContain("flash");
    expect(dialog?.textContent?.toLowerCase()).not.toContain("alias");
  });

  it("Rename prefills the current model name, fixes the Provider prefix, and sends only modelName", async () => {
    const executeAliases = vi.fn(async (command) => {
      if (command.command === "query") return aliasState();
      if (command.command === "rename_model") {
        return aliasState({
          state: {
            ...aliasState().state,
            revision: 1,
            effective: {
              aliases: [
                {
                  alias: "example/sonnet",
                  target: { provider: "example", model: "model-a" },
                  layer: "user" as const,
                },
                {
                  alias: "example/flash",
                  target: { provider: "example", model: "model-b" },
                  layer: "user" as const,
                },
              ],
              errors: [],
            },
          },
        });
      }
      return aliasState();
    });

    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogQuery(),
          executeAliases,
        },
      }),
    );
    await click("Models 2");
    await click("Rename");
    const editor = container.querySelector(".model-name-editor");
    expect(editor?.textContent).toContain("example/");
    expect(editor?.textContent?.toLowerCase()).not.toContain("alias");
    const input = editor?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("model name input missing");
    expect(input.value).toBe("model-a");
    await act(async () => setInput(input, "sonnet"));
    await click("Save");
    expect(executeAliases).toHaveBeenCalledWith({
      command: "rename_model",
      revision: 0,
      providerId: "example",
      modelId: "model-a",
      modelName: "sonnet",
    });
    expect(container.textContent).toContain("sonnet");
  });

  it("rejects slash-containing model names before sending rename_model", async () => {
    const executeAliases = vi.fn(async (command: { readonly command: string }) => {
      void command;
      return aliasState();
    });
    await render(createFakeDesktopApi({ control: {
      executeAuth: async () => authQuery(),
      executeCatalog: async () => catalogQuery(),
      executeAliases,
    } }));
    await click("Models 2");
    await click("Rename");
    const input = container.querySelector(".model-name-editor input");
    if (!(input instanceof HTMLInputElement)) throw new Error("model name input missing");
    await act(async () => setInput(input, "team/model"));
    await click("Save");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("must not contain '/'");
    expect(executeAliases.mock.calls.some(([command]) => command.command === "rename_model")).toBe(false);
  });

  it("restores a renamed model to its canonical default name", async () => {
    const executeAliases = vi.fn(async (command) => {
      if (command.command === "query") return aliasState();
      if (command.command === "restore_model_name") {
        return aliasState({
          state: {
            ...aliasState().state,
            revision: 1,
            effective: {
              aliases: [
                {
                  alias: "example/model-a",
                  target: { provider: "example", model: "model-a" },
                  layer: "default" as const,
                },
                {
                  alias: "example/model-b",
                  target: { provider: "example", model: "model-b" },
                  layer: "default" as const,
                },
              ],
              errors: [],
            },
          },
        });
      }
      return aliasState();
    });

    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogQuery(),
          executeAliases,
        },
      }),
    );
    await click("Models 2");
    const renameButtons = [...container.querySelectorAll("button")].filter(
      (entry) => entry.textContent?.trim() === "Rename",
    );
    await act(async () => renameButtons[1]?.click());
    await click("Restore default");
    expect(executeAliases).toHaveBeenCalledWith({
      command: "restore_model_name",
      revision: 0,
      providerId: "example",
      modelId: "model-b",
    });
    expect(container.textContent).toContain("model-b");
  });

  it("keeps Provider and model switches independent while the Provider is OFF", async () => {
    let state = publicModelsState({
      state: {
        ...publicModelsState().state,
        providers: [
          {
            providerId: "example",
            on: false,
            models: [
              { alias: "example/model-a", target: "model-a", on: true },
              { alias: "example/flash", target: "model-b", on: false },
            ],
          },
        ],
      },
    });
    const executePublicModels = vi.fn(async (command) => {
      if (command.command === "set_provider") {
        state = {
          ...state,
          state: {
            ...state.state,
            revision: state.state.revision + 1,
            providers: state.state.providers.map((provider) =>
              provider.providerId === command.providerId
                ? { ...provider, on: command.on }
                : provider,
            ),
          },
        };
      }
      if (command.command === "set_model") {
        state = {
          ...state,
          state: {
            ...state.state,
            revision: state.state.revision + 1,
            providers: state.state.providers.map((provider) => ({
              ...provider,
              models: provider.models.map((model) =>
                model.target === command.modelId ? { ...model, on: command.on } : model,
              ),
            })),
          },
        };
      }
      return state;
    });
    await render(createFakeDesktopApi({ control: {
      executeAuth: async () => authQuery(),
      executeCatalog: async () => catalogQuery(),
      executePublicModels,
    } }));

    const turnOnProvider = container.querySelector('button[aria-label="Turn on Example AI"]');
    expect(turnOnProvider).toBeInstanceOf(HTMLButtonElement);
    await act(async () => (turnOnProvider as HTMLButtonElement).click());
    expect(executePublicModels).toHaveBeenCalledWith({
      command: "set_provider",
      revision: 0,
      providerId: "example",
      on: true,
    });

    const turnOffProvider = container.querySelector('button[aria-label="Turn off Example AI"]');
    await act(async () => (turnOffProvider as HTMLButtonElement).click());
    await click("Models 2");
    const modelSwitch = container.querySelector('button[aria-label="Turn off model-a"]');
    expect(modelSwitch).toBeInstanceOf(HTMLButtonElement);
    await act(async () => (modelSwitch as HTMLButtonElement).click());
    expect(executePublicModels).toHaveBeenLastCalledWith({
      command: "set_model",
      revision: 2,
      providerId: "example",
      modelId: "model-a",
      on: false,
    });
  });

  it("keeps slash-containing canonical model IDs as secondary identity while editing the normalized model name", async () => {
    const providerId = "commandcode-private";
    const modelId = "deepseek/deepseek-v4-flash";
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () =>
            authQueryMulti([
              {
                providerId,
                name: "CommandCode Private",
                source: "luckytoken_bundled",
                stored: true,
                effectiveSource: "stored",
              },
            ]),
          executeCatalog: async () =>
            catalogQueryFor([
              {
                providerId,
                name: "CommandCode Private",
                models: [
                  { id: modelId, dynamic: true, availability: "available" as const },
                ],
              },
            ]),
          executeAliases: async () => ({
            outcome: "ok" as const,
            state: {
              revision: 0,
              path: "model-aliases.json",
              present: false,
              valid: false,
              raw: "",
              catalogVersion: 1,
              effective: {
                aliases: [
                  {
                    alias: `${providerId}/deepseek-deepseek-v4-flash`,
                    target: { provider: providerId, model: modelId },
                    layer: "default" as const,
                  },
                ],
                errors: [],
              },
            },
          }),
        },
      }),
    );

    await click("Models 1");
    expect(container.textContent).toContain(modelId);
    await click("Rename");
    const input = container.querySelector(".model-name-editor input");
    if (!(input instanceof HTMLInputElement)) throw new Error("model name input missing");
    expect(input.value).toBe("deepseek-deepseek-v4-flash");
    expect(container.querySelector(".model-name-prefix")?.textContent).toBe(`${providerId}/`);
  });

  it("shows expired auth as reconnect-required while keeping the declared auth methods", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery({ expired: true }),
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
      }),
    );
    expect(container.textContent).toContain("Reconnect required");
    expect(container.textContent).toContain("API key");
    expect(container.textContent).toContain("Auth");
  });

  it("closing an active auth card cancels the typed auth interaction", async () => {
    const respondAuth = vi.fn(async () => undefined);
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") {
        return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      }
      listener?.({ type: "progress", message: "Waiting for browser sign-in" });
      return new Promise<ReturnType<typeof authQuery>>(() => undefined);
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          respondAuth,
          executeCatalog: async () => catalogQuery(),
          executeAliases: async () => aliasState(),
        },
      }),
    );

    await click("Auth");
    expect(container.textContent).toContain("Waiting for browser sign-in");
    const close = container.querySelector('button[aria-label="Close sign in"]');
    if (!(close instanceof HTMLButtonElement)) throw new Error("close sign in missing");
    await act(async () => close.click());
    expect(respondAuth).toHaveBeenCalledWith({ type: "cancel" });
    expect(container.querySelector('[aria-label="Example AI sign in"]')).toBeNull();
  });

  it("keeps Catalog failure separate from auth state", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => {
            throw new Error("catalog unavailable");
          },
          executeAliases: async () => aliasState(),
        },
      }),
    );
    expect(container.textContent).toContain("Example AI");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Model catalog unavailable");
    expect(container.textContent).toContain("Models 2");
  });

  it("re-queries Catalog on authoritative catalog-version change", async () => {
    let version = 1;
    let statusListener: ((status: {
      readonly sequence: number;
      readonly modelDataPlane: "running";
      readonly provider: "configured";
      readonly catalog?: {
        readonly version: number;
        readonly refreshing: boolean;
        readonly failedProviderIds: readonly string[];
      };
    }) => void) | undefined;
    const executeCatalog = vi.fn(async () => {
      const result = catalogQueryFor([
        {
          providerId: "example",
          name: "Example AI",
          models: [
            { id: "model-a", dynamic: true, availability: "available" as const },
            ...(version === 2
              ? [{ id: "model-c", dynamic: true, availability: "available" as const }]
              : []),
          ],
        },
      ]);
      return { ...result, snapshot: { ...result.snapshot, version } };
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog,
          executeAliases: async () => aliasState(),
          onStatus: (listener) => {
            statusListener = listener;
            return () => undefined;
          },
        },
      }),
    );
    expect(container.textContent).toContain("Models 2");
    await act(async () => {
      version = 2;
      statusListener?.({
        sequence: 2,
        modelDataPlane: "running",
        provider: "configured",
        catalog: { version: 2, refreshing: false, failedProviderIds: [] },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(executeCatalog).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Models 2");
  });

  it("manual refresh uses the typed Catalog refresh command", async () => {
    const executeCatalog = vi.fn(async (command) => {
      if (command.command === "query") return catalogQuery();
      return {
        ...catalogQuery(),
        refresh: {
          trigger: "manual" as const,
          startedAt: 1,
          finishedAt: 2,
          providers: [],
        },
      };
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog,
          executeAliases: async () => aliasState(),
        },
      }),
    );
    await click("Refresh models");
    expect(executeCatalog).toHaveBeenLastCalledWith({
      command: "refresh",
      mode: "manual",
    });
  });
});
