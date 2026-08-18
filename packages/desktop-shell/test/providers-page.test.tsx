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
  readonly subscription?: boolean;
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
      subscription: row.subscription ?? false,
      apiKey: row.apiKey ?? true,
      status: providerStatus(row),
    })),
  },
});

const catalogQuery = () => ({
  outcome: "ok" as const,
  snapshot: {
    version: 1,
    modelsJsonValid: true,
    providers: [
      {
        providerId: "example",
        name: "Example AI",
        dynamic: true,
        state: "succeeded" as const,
        models: [
          { id: "model-a", dynamic: true, availability: "available" as const },
          { id: "model-b", dynamic: true, availability: "available" as const },
        ],
      },
    ],
    refreshErrors: [],
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
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === "Providers",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Providers nav missing");
    button.click();
  });
}

function click(name: string): Promise<void> {
  return act(async () => {
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === name,
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`);
    button.click();
  });
}

describe("Providers product slice", () => {
  it("shows typed auth and catalog state without credential values", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogQuery(),
        },
      }),
    );

    expect(container.textContent).toContain("Example AI");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("2 models available");
    expect(container.textContent).not.toContain("secret");
  });

  it("shows expired authentication as an explicit reconnect action", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery({ expired: true }),
          executeCatalog: async () => catalogQuery(),
        },
      }),
    );
    expect(container.textContent).toContain("Reconnect required");
    expect(container.textContent).toContain("Use Example account");
  });

  it("projects login events, supports cancellation, and applies the terminal authoritative status", async () => {
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const respondAuth = vi.fn(async () => undefined);
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      listener?.({ type: "progress", message: "Waiting for browser sign-in" });
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
        },
      }),
    );

    await click("Use Example account");
    expect(container.textContent).toContain("Waiting for browser sign-in");
    await click("Cancel sign-in");
    expect(respondAuth).toHaveBeenCalledWith({ type: "cancel" });

    await act(async () => loginResolve?.(authQuery()));
    expect(container.textContent).toContain("Connected");
  });

  it("refreshes model availability and shows bounded per-Provider failures", async () => {
    const executeCatalog = vi.fn(async (command) => {
      if (command.command === "query") return catalogQuery();
      return {
        ...catalogQuery(),
        refresh: {
          trigger: "manual" as const,
          startedAt: 1,
          finishedAt: 2,
          providers: [
            {
              providerId: "example",
              outcome: "failed" as const,
              error: "Provider refresh failed",
              errorCode: "provider_error",
            },
          ],
        },
      };
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog,
        },
      }),
    );

    await click("Refresh models");
    expect(executeCatalog).toHaveBeenLastCalledWith({ command: "refresh", mode: "manual" });
    expect(container.textContent).toContain("Provider refresh failed");
  });

  // ── Ticket 09: real Provider browser ──────────────────────────────

  it("renders every projected Provider generically with source labels and groups", async () => {
    const connected = {
      providerId: "commandcode-private",
      name: "CommandCode Private",
      source: "luckytoken_bundled" as const,
      stored: true,
      effectiveSource: "stored" as const,
    };
    const available = {
      providerId: "anthropic",
      name: "Anthropic",
      source: "pi_builtin" as const,
      stored: false,
      unavailable: true,
      effectiveSource: "none" as const,
    };
    const custom = {
      providerId: "my-custom",
      name: "My Custom",
      source: "user" as const,
      stored: false,
      unavailable: true,
      effectiveSource: "none" as const,
    };
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQueryMulti([connected, available, custom]),
          executeCatalog: async () =>
            catalogQueryFor([
              { providerId: "commandcode-private", name: "CommandCode Private" },
              { providerId: "anthropic", name: "Anthropic" },
              { providerId: "my-custom", name: "My Custom" },
            ]),
        },
      }),
    );

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Available");
    expect(container.textContent).toContain("CommandCode Private");
    expect(container.textContent).toContain("LuckyToken");
    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).toContain("Built in");
    expect(container.textContent).toContain("My Custom");
    expect(container.textContent).toContain("Custom");
    expect(container.textContent).not.toContain("@luckytoken/provider-commandcode-private");
  });

  it("filters the projected Provider cards by Renderer-owned search", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () =>
            authQueryMulti([
              { providerId: "anthropic", name: "Anthropic", source: "pi_builtin", stored: false, unavailable: true, effectiveSource: "none" },
              { providerId: "openai", name: "OpenAI", source: "pi_builtin", stored: false, unavailable: true, effectiveSource: "none" },
            ]),
          executeCatalog: async () =>
            catalogQueryFor([
              { providerId: "anthropic", name: "Anthropic" },
              { providerId: "openai", name: "OpenAI" },
            ]),
        },
      }),
    );

    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).toContain("OpenAI");

    const search = container.querySelector('input[type="search"]');
    if (!(search instanceof HTMLInputElement)) throw new Error("search input missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(search, "anthrop");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(container.textContent).toContain("Anthropic");
    expect(container.textContent).not.toContain("OpenAI");
  });

  it("renders an explicit management error state when the Auth query fails instead of an empty Provider list", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => {
            throw new Error("control plane unavailable");
          },
          executeCatalog: async () => catalogQuery(),
        },
      }),
    );

    expect(container.textContent).toContain("Provider state is temporarily unavailable");
    const cards = container.querySelectorAll("article.provider-card");
    expect(cards.length).toBe(0);
  });

  it("renders an explicit Catalog failure state distinct from auth state", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => {
            throw new Error("catalog refresh failed");
          },
        },
      }),
    );

    // Provider auth facts still render; catalog is a distinct failure fact.
    expect(container.textContent).toContain("Example AI");
    expect(container.textContent).toContain("Model facts unavailable");
    expect(container.textContent).toContain("Retry models");
  });

  it("re-queries the catalog when the authoritative catalog version changes (Ticket 09)", async () => {
    let version = 1;
    let statusListener:
      | ((status: {
          readonly sequence: number;
          readonly modelDataPlane: "running";
          readonly provider: "configured";
          readonly catalog?: {
            readonly version: number;
            readonly refreshing: boolean;
            readonly failedProviderIds: readonly string[];
          };
        }) => void)
      | undefined;
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
      return {
        ...result,
        snapshot: { ...result.snapshot, version },
      };
    });
    const onStatus = vi.fn((listener) => {
      statusListener = listener;
      return () => undefined;
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog,
          onStatus,
        },
      }),
    );

    expect(container.textContent).toContain("model-a");
    await act(async () => {
      version = 2;
      statusListener?.({
        sequence: 2,
        modelDataPlane: "running",
        provider: "configured",
        catalog: { version: 2, refreshing: false, failedProviderIds: [] },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(executeCatalog).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("model-c");
  });

  // ── Ticket 10: generic Provider authentication interactions ───────

  it("submits a typed secret API-key prompt and applies the terminal state", async () => {
    const respondAuth = vi.fn(async () => undefined);
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") {
        return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      }
      listener?.({
        type: "prompt",
        promptId: "prompt-1",
        kind: "secret",
        message: "Enter the API key",
        placeholder: "sk-…",
      });
      if (listener === undefined) throw new Error("listener missing");
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
        },
      }),
    );

    await click("Use API key");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(executeAuth).toHaveBeenCalled();
    expect(executeAuth.mock.calls[1]?.[1]).toBeTypeOf("function");
    const input = container.querySelector('.auth-interaction input[type="password"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("secret input missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "sk-test-secret");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Continue");
    expect(respondAuth).toHaveBeenCalledWith({
      type: "prompt_response",
      promptId: "prompt-1",
      value: "sk-test-secret",
    });
    await act(async () => {
      loginResolve?.(authQuery());
    });
    expect(container.textContent).toContain("Connected");
  });

  it("renders OAuth auth-url and opens the browser through the typed platform seam", async () => {
    const openExternal = vi.fn(async () => undefined);
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
      return new Promise<ReturnType<typeof authQuery>>((resolve) => {
        loginResolve = resolve;
      });
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          executeCatalog: async () => catalogQuery(),
        },
        platform: { openExternal },
      }),
    );

    await click("Use Example account");
    expect(container.textContent).toContain("Authorize LuckyToken in your browser");
    expect(container.textContent).toContain("https://example.com/authorize?state=abc");
    await click("Open browser");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/authorize?state=abc");

    await act(async () => loginResolve?.(authQuery()));
    expect(container.textContent).toContain("Connected");
  });

  it("renders a device-code interaction with the verification page", async () => {
    const openExternal = vi.fn(async () => undefined);
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") {
        return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      }
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
        },
        platform: { openExternal },
      }),
    );

    await click("Use Example account");
    expect(container.textContent).toContain("ABCD-EFGH");
    await click("Open verification page");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/device");
    await act(async () => loginResolve?.(authQuery()));
    expect(container.textContent).toContain("Connected");
  });

  it("renders select and manual-code prompts generically", async () => {
    const respondAuth = vi.fn(async () => undefined);
    let loginResolve: ((value: ReturnType<typeof authQuery>) => void) | undefined;
    const executeAuth = vi.fn(async (command, listener) => {
      if (command.command === "query") {
        return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      }
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
        },
      }),
    );

    await click("Use Example account");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
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

  it("distinguishes a stored credential from a failed catalog refresh (Ticket 10)", async () => {
    const executeAuth = vi.fn(async (command) => {
      if (command.command === "query") {
        return authQuery({ unavailable: true, stored: false, effectiveSource: "none" });
      }
      // Login succeeds: credential stored, catalog refresh may still fail.
      return authQuery();
    });
    const executeCatalog = vi.fn(async (command) => {
      if (command.command === "query") return catalogQuery();
      return {
        ...catalogQuery(),
        outcome: "ok" as const,
        refresh: {
          trigger: "manual" as const,
          startedAt: 1,
          finishedAt: 2,
          providers: [
            {
              providerId: "example",
              outcome: "failed" as const,
              error: "Model refresh failed",
              errorCode: "provider_error",
            },
          ],
        },
      };
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth,
          executeCatalog,
          executeAliases: async () => ({
            outcome: "ok" as const,
            state: {
              revision: 0,
              path: "model-aliases.json",
              present: false,
              valid: false,
              raw: "",
              catalogVersion: 1,
              effective: { aliases: [], errors: [] },
            },
          }),
        },
      }),
    );

    await click("Use API key");
    expect(container.textContent).toContain("Example AI connected.");
    // The stored credential remains Connected even though the subsequent
    // model refresh failed: auth success and catalog refresh are separate
    // facts.
    expect(container.textContent).toContain("Connected");
  });

  // ── Ticket 11: model-row alias editing ────────────────────────────

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
            alias: "flash",
            target: { provider: "example", model: "model-b" },
            layer: "user" as const,
          },
        ],
        errors: [],
      },
    },
    ...overrides,
  });

  const catalogWithModels = () =>
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

  it("renders every known model with its already-assigned effective alias", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogWithModels(),
          executeAliases: async () => aliasState(),
        },
      }),
    );

    expect(container.textContent).toContain("Known models");
    expect(container.textContent).toContain("example/model-a");
    expect(container.textContent).toContain("flash");
  });

  it("shows Add alias for generated defaults and Edit alias plus Use default for custom overrides", async () => {
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogWithModels(),
          executeAliases: async () => aliasState(),
        },
      }),
    );

    expect(container.textContent).toContain("+ alias");
    expect(container.textContent).toContain("edit alias");
    expect(container.textContent).toContain("Use default");
  });

  it("opens a model-scoped editor asking only for the friendly alias value and saves through set_for_model", async () => {
    const executeAliases = vi.fn(async (command) => {
      if (command.command === "query") return aliasState();
      if (command.command === "set_for_model") {
        return {
          outcome: "ok" as const,
          state: {
            ...aliasState().state,
            revision: 1,
            present: true,
            valid: true,
            aliases: {
              "model-a": "example/model-a",
              modelb: "example/model-b",
            },
            effective: {
              aliases: [
                {
                  alias: "sonnet",
                  target: { provider: "example", model: "model-a" },
                  layer: "user" as const,
                },
                {
                  alias: "flash",
                  target: { provider: "example", model: "model-b" },
                  layer: "user" as const,
                },
              ],
              errors: [],
            },
          },
        };
      }
      return aliasState();
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogWithModels(),
          executeAliases,
        },
      }),
    );

    // Open the editor from the generated-default row.
    const addButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "+ alias",
    );
    if (addButtons.length === 0) throw new Error("Add alias button missing");
    await act(async () => addButtons[0]?.click());

    // The editor exposes no Provider selector, model selector, canonical
    // target editor, or raw JSON.
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("Custom alias");
    expect(container.textContent).toContain("Current alias");
    expect(container.textContent).not.toContain("model-aliases.json");

    const input = container.querySelector(".alias-editor input");
    if (!(input instanceof HTMLInputElement)) throw new Error("alias input missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "sonnet");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save");

    expect(executeAliases).toHaveBeenCalledWith({
      command: "set_for_model",
      revision: 0,
      providerId: "example",
      modelId: "model-a",
      alias: "sonnet",
    });
    expect(container.textContent).toContain("sonnet");
  });

  it("reset restores the generated providerId/modelId alias through reset_for_model", async () => {
    const executeAliases = vi.fn(async (command) => {
      if (command.command === "query") return aliasState();
      if (command.command === "reset_for_model") {
        return {
          outcome: "ok" as const,
          state: {
            ...aliasState().state,
            revision: 1,
            present: true,
            valid: true,
            aliases: { "model-a": "example/model-a" },
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
        };
      }
      return aliasState();
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogWithModels(),
          executeAliases,
        },
      }),
    );

    await click("Use default");
    expect(executeAliases).toHaveBeenCalledWith({
      command: "reset_for_model",
      revision: 0,
      providerId: "example",
      modelId: "model-b",
    });
    expect(container.textContent).toContain("example/model-b");
  });

  it("shows an actionable error for a rejected alias and never invents a local success", async () => {
    const executeAliases = vi.fn(async (command) => {
      if (command.command === "query") return aliasState();
      if (command.command === "set_for_model") {
        return {
          outcome: "invalid" as const,
          state: aliasState().state,
          error: {
            kind: "validation" as const,
            message: "The alias proposal was rejected: 1 entry cannot map to a canonical target.",
            entries: [
              {
                alias: "example/model-a",
                code: "duplicate" as const,
                message: "collision",
              },
            ],
          },
        };
      }
      return aliasState();
    });
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () => authQuery(),
          executeCatalog: async () => catalogWithModels(),
          executeAliases,
        },
      }),
    );

    const addButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent?.trim() === "+ alias",
    );
    await act(async () => addButtons[0]?.click());
    const input = container.querySelector(".alias-editor input");
    if (!(input instanceof HTMLInputElement)) throw new Error("alias input missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "duplicate-name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save");

    expect(container.textContent).toContain("The alias proposal was rejected");
    // The previously effective alias remains displayed, not the rejected one.
    expect(container.textContent).toContain("example/model-a");
    expect(container.textContent).not.toContain("duplicate-name");
  });

  it("renders model IDs containing / exactly and never reparses them (Ticket 11)", async () => {
    const catalogWithSlash = () =>
      catalogQueryFor([
        {
          providerId: "commandcode-private",
          name: "CommandCode Private",
          models: [
            {
              id: "deepseek/deepseek-v4-flash",
              dynamic: true,
              availability: "available" as const,
            },
          ],
        },
      ]);
    const aliasesWithSlash = {
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
              alias: "commandcode-private/deepseek/deepseek-v4-flash",
              target: {
                provider: "commandcode-private",
                model: "deepseek/deepseek-v4-flash",
              },
              layer: "default" as const,
            },
          ],
          errors: [],
        },
      },
    };
    await render(
      createFakeDesktopApi({
        control: {
          executeAuth: async () =>
            authQueryMulti([
              {
                providerId: "commandcode-private",
                name: "CommandCode Private",
                source: "luckytoken_bundled",
                stored: true,
                effectiveSource: "stored",
              },
            ]),
          executeCatalog: async () => catalogWithSlash(),
          executeAliases: async () => aliasesWithSlash,
        },
      }),
    );

    expect(container.textContent).toContain(
      "commandcode-private/deepseek/deepseek-v4-flash",
    );
  });
});
