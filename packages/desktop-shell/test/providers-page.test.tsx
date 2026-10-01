// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProvidersPage } from "../src/renderer/providers/ProvidersPage.js";
import type { DesktopControlPlaneApi } from "../src/shared/desktop-api.js";
import { createFakeDesktopApi } from "./support/fake-desktop-api.js";

let container: HTMLDivElement;
let root: Root;
type ProfilesResult = Awaited<
  ReturnType<DesktopControlPlaneApi["executeCredentialProfiles"]>
>;
type RequestJourneyListener = Parameters<
  DesktopControlPlaneApi["onRequestJourneys"]
>[0];

const providerOptions = {
  providers: [
    {
      providerId: "aws-provider",
      name: "AWS Provider",
      source: "pi_builtin" as const,
      authMethods: [
        {
          authType: "api_key" as const,
          authMethodLabel: "AWS credentials or bearer token",
          interactive: true,
        },
        {
          authType: "oauth" as const,
          authMethodLabel: "AWS organization sign-in",
          interactive: true,
        },
      ],
    },
  ],
} as const;

const emptyProfiles = () => ({
  outcome: "ok" as const,
  state: {
    providers: [
      {
        providerId: "aws-provider",
        implementationAvailable: true,
        revision: "absent",
        ambient: {
          kind: "external" as const,
          status: "unknown" as const,
          message: "External auth is resolved only when the Provider is used",
        },
        profiles: [],
      },
    ],
  },
  options: providerOptions,
});

const managedProfiles = () => ({
  outcome: "ok" as const,
  state: {
    providers: [
      {
        providerId: "aws-provider",
        implementationAvailable: true,
        revision: "revision-a",
        selectionGeneration: "selection-a",
        activeCredentialId: "credential-a",
        switchPolicy: { apiKeyOn429: false, oauthOn429: false },
        profiles: [
          {
            credentialId: "credential-a",
            authType: "api_key" as const,
            authMethodLabel: "AWS credentials or bearer token",
            displayName: "Production role",
            note: "Release traffic",
            identityHint: "•••• 7K2P",
            enabled: true,
            health: "ready" as const,
            priority: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            credentialId: "credential-b",
            authType: "oauth" as const,
            authMethodLabel: "AWS organization sign-in",
            displayName: "Incident account",
            enabled: true,
            health: "reconnect_required" as const,
            priority: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ],
  },
  options: providerOptions,
});

const notYetVerifiedProfiles = (): ProfilesResult => {
  const managed = managedProfiles();
  return {
    ...managed,
    state: {
      providers: managed.state.providers.map((provider) => ({
        ...provider,
        profiles: provider.profiles.map((profile) =>
          profile.credentialId === "credential-a"
            ? { ...profile, health: "not_yet_verified" as const }
            : profile,
        ),
      })),
    },
  };
};

/** External Codex-style source: verified login, zero managed Profiles. */
const externalConnectedProfiles = (): ProfilesResult => ({
  outcome: "ok",
  state: {
    providers: [
      {
        providerId: "aws-provider",
        implementationAvailable: true,
        revision: "absent",
        ambient: {
          kind: "external" as const,
          status: "connected" as const,
          displayName: "Codex login" as const,
          message: "Codex login is connected and refreshed in place by Codex",
        },
        profiles: [],
      },
    ],
  },
  options: providerOptions,
});

const verifiedProfiles = (): ProfilesResult => {
  const managed = managedProfiles();
  return {
    ...managed,
    state: {
      providers: managed.state.providers.map((provider) => ({
        ...provider,
        profiles: provider.profiles.map((profile) =>
          profile.credentialId === "credential-a"
            ? { ...profile, lastSucceededAt: 1_725_000_000_000 }
            : profile,
        ),
      })),
    },
  };
};

const catalog = () => ({
  outcome: "ok" as const,
  snapshot: {
    version: 1,
    modelsJsonValid: true,
    providers: [
      {
        providerId: "aws-provider",
        name: "AWS Provider",
        dynamic: true,
        state: "succeeded" as const,
        models: [
          {
            id: "model-a",
            api: "bedrock-converse",
            dynamic: true,
            availability: "available" as const,
          },
          {
            id: "model-b",
            api: "bedrock-converse",
            dynamic: true,
            availability: "unavailable" as const,
          },
        ],
      },
    ],
    refreshErrors: [],
  },
});

const publicModels = () => ({
  outcome: "ok" as const,
  state: {
    revision: 1,
    version: 1,
    endpoint: { host: "127.0.0.1", port: 3000 },
    providers: [
      {
        providerId: "aws-provider",
        on: true,
        favorite: false,
        models: [
          {
            alias: "aws-provider/model-a",
            target: "model-a",
            on: true,
            favorite: false,
          },
          {
            alias: "aws-provider/model-beta",
            target: "model-b",
            on: false,
            favorite: true,
          },
        ],
      },
    ],
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
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  container.remove();
});

async function render(options: {
  readonly view?: "providers" | "favorites";
  readonly onCloseFavoriteModels?: () => void;
  readonly profiles?: ProfilesResult;
  readonly executeCredentialProfiles?: DesktopControlPlaneApi["executeCredentialProfiles"];
  readonly executeProviderProfileAuth?: DesktopControlPlaneApi["executeProviderProfileAuth"];
  readonly respondAuth?: DesktopControlPlaneApi["respondAuth"];
  readonly executeCatalog?: DesktopControlPlaneApi["executeCatalog"];
  readonly executeProviderUsage?: DesktopControlPlaneApi["executeProviderUsage"];
  readonly executePublicModels?: DesktopControlPlaneApi["executePublicModels"];
  readonly onBackendState?: DesktopControlPlaneApi["onBackendState"];
  readonly onRequestJourneys?: DesktopControlPlaneApi["onRequestJourneys"];
} = {}): Promise<void> {
  const initial = options.profiles ?? emptyProfiles();
  const api = createFakeDesktopApi({
    control: {
      executeCredentialProfiles:
        options.executeCredentialProfiles ?? (async () => initial),
      executeProviderProfileAuth:
        options.executeProviderProfileAuth ??
        (async () => ({
          outcome: "ok" as const,
          state: initial.state,
          ...(initial.options === undefined ? {} : { options: initial.options }),
        })),
      respondAuth: options.respondAuth ?? (async () => undefined),
      executeCatalog: options.executeCatalog ?? (async () => catalog()),
      executeProviderUsage:
        options.executeProviderUsage ??
        (async () => ({
          outcome: "ok" as const,
          snapshot: {
            providers: [
              {
                providerId: "aws-provider",
                state: "unsupported" as const,
                reason: "provider" as const,
              },
            ],
          },
        })),
      executePublicModels:
        options.executePublicModels ?? (async () => publicModels()),
      onBackendState:
        options.onBackendState ?? (() => () => undefined),
      onRequestJourneys:
        options.onRequestJourneys ?? (() => () => undefined),
    },
  });
  await act(async () => {
    root.render(<ProvidersPage api={api} {...(options.view === undefined ? {} : { view: options.view })} {...(options.onCloseFavoriteModels === undefined ? {} : { onCloseFavoriteModels: options.onCloseFavoriteModels })} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === name,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${name}`);
  }
  return found;
}

function ariaButton(name: string): HTMLButtonElement {
  const found = container.querySelector(`button[aria-label="${name}"]`);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Missing aria button: ${name}`);
  }
  return found;
}

async function click(name: string): Promise<void> {
  await act(async () => {
    button(name).click();
    await Promise.resolve();
  });
}

async function clickAria(name: string): Promise<void> {
  await act(async () => {
    ariaButton(name).click();
    await Promise.resolve();
  });
}

function usageRegion(): HTMLElement {
  const found = container.querySelector('.provider-usage[role="button"]');
  if (!(found instanceof HTMLElement)) throw new Error("Missing refreshable usage region");
  return found;
}

async function doubleClickUsage(): Promise<void> {
  await act(async () => {
    usageRegion().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await Promise.resolve();
  });
}

function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Providers Profile product slice", () => {
  it("refreshes an open Profile card after that Profile serves a successful request", async () => {
    let listener: RequestJourneyListener | undefined;
    const executeCredentialProfiles = vi
      .fn<DesktopControlPlaneApi["executeCredentialProfiles"]>()
      .mockResolvedValueOnce(notYetVerifiedProfiles())
      .mockResolvedValue(verifiedProfiles());
    await render({
      executeCredentialProfiles,
      onRequestJourneys: (next) => {
        listener = next;
        return () => undefined;
      },
    });

    await clickAria("Manage AWS Provider profiles");
    expect(container.textContent).toContain("not yet verified");

    await act(async () => {
      listener?.({
        id: 9,
        runtimeId: "runtime-1",
        requestId: "request-9",
        operation: "model_generation",
        path: "/v1/responses",
        profileId: "credential-a",
        outcome: "success",
        completeness: "complete",
        createdAt: 1_725_000_000_000,
        closedAt: 1_725_000_001_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(executeCredentialProfiles).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Last success");
    expect(container.textContent).not.toContain("not yet verified");
  });

  it("keeps Provider facts on the outer card and Profile facts in secondary cards", async () => {
    await render({ profiles: managedProfiles() });
    const providerCard = container.querySelector(".provider-card");
    expect(providerCard?.textContent).not.toContain("Built in");
    expect(providerCard?.textContent).not.toContain("Release traffic");
    expect(providerCard?.textContent).not.toContain("AWS organization sign-in");
    expect(
      providerCard?.querySelector('[data-provider-icon="fallback"]')?.textContent,
    ).toBe("A");
    expect(
      providerCard?.querySelector('[aria-label="1 published, 1 currently available"]'),
    ).not.toBeNull();

    const manageProfiles = providerCard?.querySelector(
      'button[aria-label="Manage AWS Provider profiles"]',
    );
    expect(manageProfiles).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (manageProfiles as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-profile-id]")).toHaveLength(2);
    expect(container.textContent).toContain("API key");
    expect(container.textContent).toContain("OAuth account");
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    expect(container.textContent).not.toContain("Use now");
    expect(container.textContent).not.toContain("Earlier");
    expect(container.textContent).not.toContain("Later");
  });

  it("persists a dragged Profile order through one typed authority command", async () => {
    const executeCredentialProfiles = vi.fn(async () => managedProfiles());
    await render({ profiles: managedProfiles(), executeCredentialProfiles });
    await clickAria("Manage AWS Provider profiles");
    const source = container.querySelector('[data-profile-id="credential-b"]');
    const target = container.querySelector('[data-profile-id="credential-a"]');

    await act(async () => {
      source?.dispatchEvent(new Event("dragstart", { bubbles: true }));
      target?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      target?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "reorder_profiles",
      providerId: "aws-provider",
      credentialIds: ["credential-b", "credential-a"],
      expectedRevision: "revision-a",
    });
  });

  it("opens a searchable Models card list from the Provider icon action", async () => {
    await render({ profiles: managedProfiles() });
    const manageModels = container.querySelector(
      'button[aria-label="Manage AWS Provider models"]',
    );
    expect(manageModels).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      (manageModels as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const modelSearch = container.querySelector(
      'input[aria-label="Search models"]',
    );
    expect(modelSearch).toBeInstanceOf(HTMLInputElement);

    await act(async () => setInput(modelSearch as HTMLInputElement, "beta"));
    expect(container.textContent).toContain("model-beta");
    expect(container.textContent).not.toContain("model-a");
    expect(
      container.querySelector('[data-model-id="model-b"]')?.getAttribute("draggable"),
    ).toBe("false");
  });

  it("shows favorite models in a compact dialog", async () => {
    const onCloseFavoriteModels = vi.fn();
    await render({ profiles: managedProfiles(), view: "favorites", onCloseFavoriteModels });

    const dialog = container.querySelector('[role="dialog"][aria-label="Favorite models"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.classList.contains("favorite-models-modal")).toBe(true);
    expect(dialog?.textContent).toContain("model-beta");
    expect(dialog?.textContent).toContain("Provider: AWS Provider");
    expect(dialog?.textContent).not.toContain("model-a");
    expect(
      dialog?.querySelector('[data-model-id="model-b"]')?.getAttribute("draggable"),
    ).toBe("false");
    await clickAria("Close favorite models");
    expect(onCloseFavoriteModels).toHaveBeenCalledOnce();
  });

  it("uses the shared secondary-card UI for model-specific controls", async () => {
    await render({ profiles: managedProfiles() });
    await clickAria("Manage AWS Provider models");

    expect(container.querySelectorAll(".secondary-card[data-model-id]")).toHaveLength(2);
    expect(
      container.querySelector('[aria-label="Drag model-beta to reorder"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="model-a is available"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-model-id="model-a"] .model-card-title [aria-label="model-a is available"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector('button[aria-label="Hide model-a"]')).not.toBeNull();
    expect(container.textContent).toContain("Pi API: bedrock-converse");
    expect(
      container.querySelector('button[aria-label="Rename model-beta"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Rename");
    expect(container.textContent).not.toContain("Published");
  });

  it("displays runtime Pi APIs generically across different Providers", async () => {
    const baseProfiles = emptyProfiles();
    const profiles: ProfilesResult = {
      ...baseProfiles,
      state: {
        providers: [
          ...baseProfiles.state.providers,
          {
            providerId: "anthropic",
            implementationAvailable: true,
            revision: "absent",
            ambient: {
              kind: "external",
              status: "unknown",
              message: "External auth is resolved only when the Provider is used",
            },
            profiles: [],
          },
          {
            providerId: "commandcode-private",
            implementationAvailable: true,
            revision: "absent",
            ambient: {
              kind: "external",
              status: "unknown",
              message: "External auth is resolved only when the Provider is used",
            },
            profiles: [],
          },
        ],
      },
    };
    const executeCatalog: DesktopControlPlaneApi["executeCatalog"] = async () => ({
      outcome: "ok",
      snapshot: {
        version: 1,
        modelsJsonValid: true,
        providers: [
          {
            providerId: "anthropic",
            name: "Anthropic",
            dynamic: false,
            state: "known",
            models: [
              {
                id: "claude-test",
                api: "anthropic-messages",
                dynamic: false,
                availability: "available",
              },
            ],
          },
          {
            providerId: "commandcode-private",
            name: "CommandCode Private",
            dynamic: false,
            state: "known",
            models: [
              {
                id: "private-test",
                api: "commandcode-private",
                dynamic: false,
                availability: "available",
              },
            ],
          },
        ],
        refreshErrors: [],
      },
    });
    const executePublicModels: DesktopControlPlaneApi["executePublicModels"] = async () => ({
      outcome: "ok",
      state: {
        revision: 1,
        version: 1,
        endpoint: { host: "127.0.0.1", port: 3000 },
        providers: [
          {
            providerId: "anthropic",
            on: true,
            favorite: false,
            models: [
              {
                alias: "anthropic/claude-test",
                target: "claude-test",
                on: true,
                favorite: false,
              },
            ],
          },
          {
            providerId: "commandcode-private",
            on: true,
            favorite: false,
            models: [
              {
                alias: "commandcode-private/private-test",
                target: "private-test",
                on: true,
                favorite: false,
              },
            ],
          },
        ],
      },
    });

    await render({ profiles, executeCatalog, executePublicModels });

    await clickAria("Manage anthropic models");
    expect(container.textContent).toContain("Pi API: anthropic-messages");

    await clickAria("Close models");
    await clickAria("Manage commandcode-private models");
    expect(container.textContent).toContain("Pi API: commandcode-private");
  });

  it("retries an idempotent Public Models update once after a stale revision", async () => {
    const initial = publicModels();
    const refreshed = {
      ...initial,
      outcome: "conflict" as const,
      state: { ...initial.state, revision: 2, version: 2 },
    };
    const applied = {
      ...initial,
      state: {
        ...initial.state,
        revision: 3,
        version: 3,
        providers: initial.state.providers.map((provider) => ({
          ...provider,
          favorite: true,
        })),
      },
    };
    const executePublicModels = vi.fn(async (command) => {
      if (command.command === "query") return initial;
      if (command.command !== "set_provider_favorite") return initial;
      return command.revision === 1 ? refreshed : applied;
    }) as DesktopControlPlaneApi["executePublicModels"];
    await render({ profiles: managedProfiles(), executePublicModels });

    await clickAria("Favorite AWS Provider");

    expect(executePublicModels).toHaveBeenNthCalledWith(2, {
      command: "set_provider_favorite",
      revision: 1,
      providerId: "aws-provider",
      favorite: true,
    });
    expect(executePublicModels).toHaveBeenNthCalledWith(3, {
      command: "set_provider_favorite",
      revision: 2,
      providerId: "aws-provider",
      favorite: true,
    });
    expect(container.querySelector('button[aria-label="Unfavorite AWS Provider"]')).not.toBeNull();
  });

  it("uses icon-only actions while editing a model name", async () => {
    await render({ profiles: managedProfiles() });
    await clickAria("Manage AWS Provider models");
    await clickAria("Rename model-beta");

    const editor = container.querySelector(".model-name-editor");
    expect(editor).not.toBeNull();
    expect(editor?.querySelector('button[aria-label="Save model name"]')).not.toBeNull();
    expect(editor?.querySelector('button[aria-label="Cancel editing"]')).not.toBeNull();
    expect(editor?.querySelector('button[aria-label="Restore default name"]')).not.toBeNull();
    expect(
      [...(editor?.querySelectorAll("button") ?? [])].map((entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["", "", ""]);
    expect(editor?.textContent).not.toContain("Save");
    expect(editor?.textContent).not.toContain("Cancel");
    expect(editor?.textContent).not.toContain("Restore default");
  });

  it("edits the model-name input and publishes the returned Public Models state", async () => {
    const initial = publicModels();
    const applied = {
      ...initial,
      state: {
        ...initial.state,
        revision: 2,
        version: 2,
        providers: initial.state.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) =>
            model.target === "model-b"
              ? { ...model, alias: "aws-provider/custom-beta" }
              : model,
          ),
        })),
      },
    };
    const executePublicModels = vi.fn(async (command) =>
      command.command === "rename_model" ? applied : initial,
    ) as DesktopControlPlaneApi["executePublicModels"];
    await render({ profiles: managedProfiles(), executePublicModels });
    await clickAria("Manage AWS Provider models");
    await clickAria("Rename model-beta");
    const input = container.querySelector('.model-name-editor input[type="text"]');
    expect(input).toBeInstanceOf(HTMLInputElement);

    await act(async () => setInput(input as HTMLInputElement, "custom-beta"));
    expect((input as HTMLInputElement).value).toBe("custom-beta");
    await clickAria("Save model name");

    expect(executePublicModels).toHaveBeenCalledWith({
      command: "rename_model",
      revision: 1,
      providerId: "aws-provider",
      modelId: "model-b",
      modelName: "custom-beta",
    });
    expect(container.textContent).toContain("custom-beta");
    expect(container.querySelector(".model-name-editor")).toBeNull();
  });

  it("persists a dragged model order through the typed Public Models command", async () => {
    const executePublicModels = vi.fn(async () => publicModels());
    await render({ profiles: managedProfiles(), executePublicModels });
    const manageModels = container.querySelector(
      'button[aria-label="Manage AWS Provider models"]',
    ) as HTMLButtonElement;

    await act(async () => {
      manageModels.click();
      await Promise.resolve();
    });
    const source = container.querySelector('[data-model-id="model-b"]');
    const target = container.querySelector('[data-model-id="model-a"]');
    expect(source).toBeInstanceOf(HTMLLIElement);
    expect(target).toBeInstanceOf(HTMLLIElement);

    await act(async () => {
      source?.dispatchEvent(new Event("dragstart", { bubbles: true }));
      target?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      target?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(executePublicModels).toHaveBeenCalledWith({
      command: "reorder_models",
      revision: 1,
      providerId: "aws-provider",
      modelIds: ["model-b", "model-a"],
    });
  });

  it("renders named Profiles with generic credential types and health in the secondary cards", async () => {
    await render({ profiles: managedProfiles() });
    await clickAria("Manage AWS Provider profiles");

    expect(container.textContent).toContain("Production role");
    expect(container.textContent).toContain("Incident account");
    expect(container.textContent).toContain("API key");
    expect(container.textContent).toContain("OAuth account");
    expect(container.textContent).toContain("reconnect required");
    expect(container.textContent).not.toContain("Use API key");
    expect(container.textContent).not.toContain("Account 1");
  });

  it("opens Profile actions in a separate tall tertiary card", async () => {
    await render({ profiles: managedProfiles() });
    await clickAria("Manage AWS Provider profiles");
    await clickAria("More actions for Incident account");

    const incidentCard = container.querySelector('[data-profile-id="credential-b"]');
    const actionsDialog = container.querySelector(
      '.profile-actions-modal[role="dialog"][aria-label="Actions for Incident account"]',
    );
    expect(actionsDialog).not.toBeNull();
    expect(incidentCard?.contains(actionsDialog)).toBe(false);
    expect(incidentCard?.querySelector(".profile-actions-card")).toBeNull();
    expect(actionsDialog?.textContent).toContain("Incident account");
    expect(actionsDialog?.textContent).toContain("OAuth account");
    expect(actionsDialog?.textContent).toContain("Rename / note");
    expect(actionsDialog?.textContent).toContain("Reconnect");
    expect(actionsDialog?.textContent).toContain("Remove");

    await clickAria("Close Profile actions");
    await clickAria("More actions for Production role");
    expect(
      container.querySelector('[aria-label="Actions for Incident account"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Actions for Production role"]'),
    ).not.toBeNull();
  });

  it("searches sanitized Profile names, notes, labels, and identity hints", async () => {
    await render({ profiles: managedProfiles() });
    const search = container.querySelector('input[type="search"]');
    expect(search).toBeInstanceOf(HTMLInputElement);

    await act(async () => setInput(search as HTMLInputElement, "incident"));
    expect(container.textContent).toContain("AWS Provider");
    await act(async () => setInput(search as HTMLInputElement, "7k2p"));
    expect(container.textContent).toContain("Production role");
    await act(async () => setInput(search as HTMLInputElement, "missing"));
    expect(container.textContent).not.toContain("Production role");
  });

  it("shows API key entry immediately and adds a named Profile with one submit", async () => {
    const respondAuth = vi.fn(async () => undefined);
    const executeProviderProfileAuth = vi.fn(async (_command, onInteraction) => {
      onInteraction?.({
        type: "prompt",
        promptId: "api-key-prompt",
        kind: "secret",
        message: "Enter API key",
      });
      await Promise.resolve();
      return managedProfiles();
    });
    await render({ executeProviderProfileAuth, respondAuth });

    await clickAria("Add AWS credentials or bearer token");
    const name = container.querySelector('input[maxlength="64"]');
    const note = container.querySelector('textarea[maxlength="200"]');
    const apiKey = container.querySelector('input[type="password"]');
    expect(name).toBeInstanceOf(HTMLInputElement);
    expect(note).toBeInstanceOf(HTMLTextAreaElement);
    expect(apiKey).toBeInstanceOf(HTMLInputElement);
    expect(executeProviderProfileAuth).not.toHaveBeenCalled();
    expect((name as HTMLInputElement).value).toBe("Profile 1");
    await act(async () => {
      setInput(name as HTMLInputElement, "Production role");
      setInput(note as HTMLTextAreaElement, "Release traffic");
      setInput(apiKey as HTMLInputElement, "sk-direct-entry");
    });
    await click("Continue");

    expect(executeProviderProfileAuth).toHaveBeenCalledWith(
      {
        command: "login",
        providerId: "aws-provider",
        authType: "api_key",
        displayName: "Production role",
        note: "Release traffic",
        useNow: true,
        expectedRevision: "absent",
      },
      expect.any(Function),
    );
    expect(respondAuth).toHaveBeenCalledWith({
      type: "prompt_response",
      promptId: "api-key-prompt",
      value: "sk-direct-entry",
    });
  });

  it("sends local lifecycle commands with the authoritative Provider revision", async () => {
    const executeCredentialProfiles = vi.fn(async () => managedProfiles());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await render({ profiles: managedProfiles(), executeCredentialProfiles });

    await clickAria("Manage AWS Provider profiles");
    await clickAria("More actions for Production role");
    await clickAria("Disable");
    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "set_enabled",
      providerId: "aws-provider",
      credentialId: "credential-a",
      expectedRevision: "revision-a",
      enabled: false,
    });

    await clickAria("More actions for Incident account");
    await clickAria("Remove");
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/may remain valid at the Provider.*revoke it/iu),
    );
    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "remove",
      providerId: "aws-provider",
      credentialId: "credential-b",
      expectedRevision: "revision-a",
    });
  });

  it("places method-specific HTTP 429 switching in the sign-in dialog", async () => {
    const executeCredentialProfiles = vi.fn(async (command) => {
      const result = managedProfiles();
      if (command.command !== "set_switch_policy") return result;
      return {
        ...result,
        state: {
          providers: result.state.providers.map((provider) => ({
            ...provider,
            switchPolicy: {
              apiKeyOn429: command.apiKeyOn429,
              oauthOn429: command.oauthOn429,
            },
          })),
        },
      };
    });
    await render({ profiles: managedProfiles(), executeCredentialProfiles });
    expect(container.querySelector('.provider-card [aria-label*="HTTP 429"]')).toBeNull();
    await clickAria("Add AWS credentials or bearer token");
    const fallback = ariaButton("Enable HTTP 429 Profile switching for AWS Provider AWS credentials or bearer token");
    expect(fallback.getAttribute("aria-pressed")).toBe("false");
    await clickAria("Enable HTTP 429 Profile switching for AWS Provider AWS credentials or bearer token");

    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "set_switch_policy",
      providerId: "aws-provider",
      expectedRevision: "revision-a",
      apiKeyOn429: true,
      oauthOn429: false,
    });
    const enabledFallback = ariaButton("Disable HTTP 429 Profile switching for AWS Provider AWS credentials or bearer token");
    expect(enabledFallback.getAttribute("aria-pressed")).toBe("true");
    expect(enabledFallback.classList.contains("on")).toBe(true);
    expect(enabledFallback.getAttribute("title")).toBe("Disable HTTP 429 Profile switching");

    await clickAria("Close sign in");
    await clickAria("Add AWS organization sign-in");
    await clickAria("Enable HTTP 429 Profile switching for AWS Provider AWS organization sign-in");
    expect(executeCredentialProfiles).toHaveBeenLastCalledWith({
      command: "set_switch_policy",
      providerId: "aws-provider",
      expectedRevision: "revision-a",
      apiKeyOn429: true,
      oauthOn429: true,
    });
  });

  it("explains why HTTP 429 switching is unavailable before the first Profile", async () => {
    await render();
    await clickAria("Add AWS credentials or bearer token");
    expect(container.textContent).toContain("Add a Profile to configure switching.");
    expect(ariaButton("Enable HTTP 429 Profile switching for AWS Provider AWS credentials or bearer token").disabled).toBe(true);
  });

  it("queries cached Provider usage on page load and refreshes on usage double-click", async () => {
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      if (command.command === "query") {
        return {
          outcome: "ok",
          snapshot: {
            providers: [
              {
                providerId: "aws-provider",
                state: "unobserved",
              },
            ],
          },
        };
      }
      return {
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "aws-provider",
              state: "observed",
              observedAt: 1,
              refreshable: true,
              windows: [{ kind: "weekly", usedPercent: 25 }],
              budgets: [],
            },
          ],
        },
        refresh: {
          providerId: "aws-provider",
          outcome: "succeeded",
        },
      };
    });
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
    });

    expect(executeProviderUsage).toHaveBeenCalledWith({ command: "query" });
    expect(
      executeProviderUsage.mock.calls.some(
        ([command]) => command.command === "refresh",
      ),
    ).toBe(false);
    expect(container.textContent).toContain("Usage not refreshed");
    expect(container.querySelector('button[title="Refresh usage"]')).toBeNull();
    await act(async () => {
      usageRegion().click();
      await Promise.resolve();
    });
    expect(executeProviderUsage.mock.calls.some(([command]) => command.command === "refresh")).toBe(false);

    await doubleClickUsage();

    expect(executeProviderUsage).toHaveBeenCalledWith({
      command: "refresh",
      providerId: "aws-provider",
    });
    expect(container.textContent).toContain("Week 25%");
    expect(usageRegion().getAttribute("aria-label")).toContain("Week 25%");
    await act(async () => {
      usageRegion().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(executeProviderUsage.mock.calls.filter(([command]) => command.command === "refresh")).toHaveLength(2);
  });

  it("hides usage when a Provider has no connected Profile", async () => {
    await render({
      profiles: emptyProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: {
          providers: [{
            providerId: "aws-provider",
            state: "observed",
            observedAt: 1,
            refreshable: true,
            windows: [{ kind: "weekly", usedPercent: 25 }],
            budgets: [],
          }],
        },
      }),
    });

    expect(container.querySelector('[aria-label^="AWS Provider usage"]')).toBeNull();
    expect(container.textContent).not.toContain("Week 25%");
  });

  it("shows refreshable usage for a connected Profile that is not yet verified", async () => {
    await render({
      profiles: notYetVerifiedProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: {
          providers: [{
            providerId: "aws-provider",
            state: "unobserved",
          }],
        },
      }),
    });

    expect(container.textContent).toContain("Usage not refreshed");
    expect(usageRegion().getAttribute("aria-label")).toContain("Double-click or press Enter to refresh");
  });

  it("shows usage for a verified external Codex login with no managed Profile", async () => {
    await render({
      profiles: externalConnectedProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: {
          providers: [{
            providerId: "aws-provider",
            state: "observed",
            observedAt: 1,
            refreshable: true,
            windows: [{ kind: "weekly", usedPercent: 25 }],
            budgets: [],
          }],
        },
      }),
    });

    expect(usageRegion().getAttribute("aria-label")).toContain("Week 25%");
    expect(container.textContent).not.toContain("Usage not refreshed");
  });

  it("labels a verified external Codex login instead of the generic not-connected copy", async () => {
    await render({
      profiles: externalConnectedProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: { providers: [{ providerId: "aws-provider", state: "unobserved" }] },
      }),
    });

    const status = container.querySelector('[aria-label="Codex login"]');
    expect(status).not.toBeNull();
    expect(container.textContent).toContain("Codex login");
    expect(container.textContent).not.toContain("Not connected");
    expect(container.querySelector(".status-dot.good")).not.toBeNull();
  });

  it("groups a verified external Codex login under Connected", async () => {
    await render({
      profiles: externalConnectedProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: { providers: [{ providerId: "aws-provider", state: "unobserved" }] },
      }),
    });

    const groups = [...container.querySelectorAll(".provider-group")];
    const connected = groups.find(
      (group) =>
        group.querySelector(".provider-group-title")?.textContent === "Connected",
    );
    expect(connected).toBeDefined();
    expect(connected?.textContent).toContain("AWS Provider");
    expect(
      groups.some(
        (group) =>
          group.querySelector(".provider-group-title")?.textContent === "Available",
      ),
    ).toBe(false);
  });

  it("lists a verified external Codex login as a read-only credential source", async () => {
    await render({
      profiles: externalConnectedProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: { providers: [{ providerId: "aws-provider", state: "unobserved" }] },
      }),
    });

    await clickAria("Manage AWS Provider credentials");

    const dialog = container.querySelector(
      '[role="dialog"][aria-label="AWS Provider profiles"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("AWS Provider · 1 profile");
    expect(dialog?.textContent).toContain("Codex login");
    expect(dialog?.textContent).toContain("External · read-only · connected");
    expect(dialog?.textContent).toContain(
      "Codex login is connected and refreshed in place by Codex",
    );
    expect(dialog?.querySelector('[aria-label^="More actions for"]')).toBeNull();
    expect(dialog?.querySelector('input[type="radio"]')).toBeNull();
  });

  it("keeps an absent external login out of Connected and the Profile list", async () => {
    const connected = externalConnectedProfiles();
    await render({
      profiles: {
        ...connected,
        state: {
          providers: connected.state.providers.map((provider) => ({
            ...provider,
            ambient: {
              kind: "external" as const,
              status: "unknown" as const,
              displayName: "Codex login" as const,
              message:
                "External credentials are not available; configure them through their source owner",
            },
          })),
        },
      },
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: { providers: [{ providerId: "aws-provider", state: "unobserved" }] },
      }),
    });

    expect(
      container.querySelector('button[aria-label="Manage AWS Provider credentials"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-label="Codex login"]')).toBeNull();
    expect(container.querySelector('[aria-label="Not connected"]')).not.toBeNull();
    const groups = [...container.querySelectorAll(".provider-group")];
    expect(
      groups.some(
        (group) =>
          group.querySelector(".provider-group-title")?.textContent === "Connected",
      ),
    ).toBe(false);
  });

  it("counts a present but unreadable external login as a Profile needing attention", async () => {
    const connected = externalConnectedProfiles();
    await render({
      profiles: {
        ...connected,
        state: {
          providers: connected.state.providers.map((provider) => ({
            ...provider,
            ambient: {
              kind: "external" as const,
              status: "configured" as const,
              displayName: "Codex login" as const,
              message:
                "External credentials are present but temporarily unreadable; retry or update through their source owner",
            },
          })),
        },
      },
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: { providers: [{ providerId: "aws-provider", state: "unobserved" }] },
      }),
    });

    const groups = [...container.querySelectorAll(".provider-group")];
    expect(
      groups.some(
        (group) =>
          group.querySelector(".provider-group-title")?.textContent === "Connected",
      ),
    ).toBe(false);
    expect(
      container.querySelector('[aria-label="Codex login needs attention"]'),
    ).not.toBeNull();

    await clickAria("Manage AWS Provider credentials");

    const dialog = container.querySelector(
      '[role="dialog"][aria-label="AWS Provider profiles"]',
    );
    expect(dialog?.textContent).toContain("AWS Provider · 1 profile");
    expect(dialog?.textContent).toContain("External · read-only · configured");
    expect(dialog?.querySelector('input[type="radio"]')).toBeNull();
  });

  it("keeps publication available for a verified external Codex login", async () => {
    const models = publicModels();
    await render({
      profiles: externalConnectedProfiles(),
      executePublicModels: async () => ({
        ...models,
        state: {
          ...models.state,
          providers: models.state.providers.map((provider) => ({
            ...provider,
            on: false,
          })),
        },
      }),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: { providers: [{ providerId: "aws-provider", state: "unobserved" }] },
      }),
    });

    const publish = container.querySelector(
      'button[aria-label="Publish AWS Provider"]',
    );
    expect(publish).not.toBeNull();
    expect(publish?.hasAttribute("disabled")).toBe(false);
  });

  it("hides unavailable usage for a connected account type", async () => {
    await render({
      profiles: managedProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: {
          providers: [{ providerId: "aws-provider", state: "unsupported", reason: "binding" }],
        },
      }),
    });

    expect(container.querySelector('[aria-label^="AWS Provider usage"]')).toBeNull();
    expect(container.textContent).not.toContain("Usage unavailable");
  });

  it("shows an automatic refresh result from cache without issuing a quota refresh", async () => {
    vi.useFakeTimers();
    let observed = false;
    const executeProviderUsage = vi.fn<DesktopControlPlaneApi["executeProviderUsage"]>(async () => ({
      outcome: "ok",
      snapshot: {
        providers: [observed
          ? { providerId: "aws-provider", state: "observed", observedAt: 1, refreshable: true, windows: [{ kind: "weekly", usedPercent: 25 }], budgets: [] }
          : { providerId: "aws-provider", state: "unobserved" }],
      },
    }));
    try {
      await render({ profiles: managedProfiles(), executeProviderUsage });
      expect(container.textContent).toContain("Usage not refreshed");
      observed = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(container.textContent).toContain("Week 25%");
      expect(executeProviderUsage.mock.calls.every(([command]) => command.command === "query")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps per-card usage refresh reachable when the initial cache query rejects", async () => {
    let calls = 0;
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      calls += 1;
      if (command.command === "query") {
        throw new Error("query unavailable");
      }
      return {
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "aws-provider",
              state: "observed",
              observedAt: 1,
              refreshable: true,
              windows: [{ kind: "weekly", usedPercent: 33 }],
              budgets: [],
            },
          ],
        },
        refresh: {
          providerId: "aws-provider",
          outcome: "succeeded",
        },
      };
    });
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
    });

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("Usage not refreshed");
    await doubleClickUsage();

    expect(executeProviderUsage).toHaveBeenCalledWith({
      command: "refresh",
      providerId: "aws-provider",
    });
    expect(container.textContent).toContain("Week 33%");
  });

  it("re-queries cache-only usage after a successful Provider request so passive observations appear", async () => {
    let listener: RequestJourneyListener | undefined;
    let queries = 0;
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      if (command.command !== "query") {
        throw new Error("passive observation must not trigger refresh");
      }
      queries += 1;
      return {
        outcome: "ok",
        snapshot: {
          providers: [
            queries === 1
              ? {
                  providerId: "aws-provider",
                  state: "unobserved" as const,
                }
              : {
                  providerId: "aws-provider",
                  state: "observed" as const,
                  observedAt: 2,
                  refreshable: false,
                  windows: [{ kind: "weekly" as const, usedPercent: 44 }],
                  budgets: [],
                },
          ],
        },
      };
    });
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
      onRequestJourneys: (next) => {
        listener = next;
        return () => undefined;
      },
    });

    expect(container.textContent).toContain("Usage not refreshed");

    await act(async () => {
      listener?.({
        id: 10,
        runtimeId: "runtime-1",
        requestId: "request-10",
        operation: "model_generation",
        path: "/v1/messages",
        providerId: "aws-provider",
        profileId: "credential-a",
        outcome: "success",
        completeness: "complete",
        createdAt: 1_725_000_000_000,
        closedAt: 1_725_000_001_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Week 44%");
    expect(
      executeProviderUsage.mock.calls.some(
        ([command]) => command.command === "refresh",
      ),
    ).toBe(false);
  });

  it("shows a safe notice when usage refresh is unsupported after auth resolution", async () => {
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      if (command.command === "query") {
        return {
          outcome: "ok",
          snapshot: {
            providers: [
              {
                providerId: "aws-provider",
                state: "unobserved",
              },
            ],
          },
        };
      }
      return {
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "aws-provider",
              state: "unobserved",
            },
          ],
        },
        refresh: {
          providerId: "aws-provider",
          outcome: "unsupported",
          reason: "destination",
        },
      };
    });
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
    });

    await doubleClickUsage();

    expect(container.textContent).toContain(
      "Provider usage cannot be refreshed for this endpoint.",
    );
  });

  it("shows a safe per-Provider notice when usage refresh transport fails", async () => {
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      if (command.command === "query") {
        return {
          outcome: "ok",
          snapshot: {
            providers: [
              {
                providerId: "aws-provider",
                state: "unobserved",
              },
            ],
          },
        };
      }
      throw new Error("control-plane failure");
    });
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
    });

    await doubleClickUsage();

    expect(container.textContent).toContain(
      "Provider usage could not be refreshed.",
    );
  });

  it("clears old usage on credential binding change and applies only the current cache query", async () => {
    let backendListener:
      | Parameters<DesktopControlPlaneApi["onBackendState"]>[0]
      | undefined;
    let releaseSecond!: (value: Awaited<
      ReturnType<DesktopControlPlaneApi["executeProviderUsage"]>
    >) => void;
    const second = new Promise<
      Awaited<ReturnType<DesktopControlPlaneApi["executeProviderUsage"]>>
    >((resolve) => {
      releaseSecond = resolve;
    });
    let queries = 0;
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      if (command.command === "refresh") {
        throw new Error("refresh must not run on binding change");
      }
      queries += 1;
      if (queries === 1) {
        return {
          outcome: "ok",
          snapshot: {
            providers: [
              {
                providerId: "aws-provider",
                state: "observed",
                observedAt: 1,
                refreshable: true,
                windows: [{ kind: "weekly", usedPercent: 90 }],
                budgets: [],
              },
            ],
          },
        };
      }
      return second;
    });
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
      onBackendState: (listener) => {
        backendListener = listener;
        return () => undefined;
      },
    });
    expect(container.textContent).toContain("Week 90%");

    const nextProfiles = managedProfiles().state;
    const switched = {
      ...nextProfiles,
      providers: nextProfiles.providers.map((provider) => ({
        ...provider,
        revision: "revision-b",
        selectionGeneration: "selection-b",
        activeCredentialId: "credential-b",
        profiles: provider.profiles.map((profile) =>
          profile.credentialId === "credential-b"
            ? { ...profile, health: "ready" as const }
            : profile,
        ),
      })),
    };
    await act(async () => {
      backendListener?.({
        kind: "ready",
        status: {
          modelDataPlane: "running",
          provider: "ready",
          credentialProfiles: switched,
        },
      } as never);
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Week 90%");
    expect(
      executeProviderUsage.mock.calls.some(
        ([command]) => command.command === "refresh",
      ),
    ).toBe(false);

    await act(async () => {
      releaseSecond({
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "aws-provider",
              state: "observed",
              observedAt: 2,
              refreshable: true,
              windows: [{ kind: "weekly", usedPercent: 12 }],
              budgets: [],
            },
          ],
        },
      });
      await second;
    });
    expect(container.textContent).toContain("Week 12%");
  });

  it("drops a stale usage refresh result after the credential binding changes", async () => {
    let backendListener:
      | Parameters<DesktopControlPlaneApi["onBackendState"]>[0]
      | undefined;
    let releaseRefresh!: (value: Awaited<
      ReturnType<DesktopControlPlaneApi["executeProviderUsage"]>
    >) => void;
    const pendingRefresh = new Promise<
      Awaited<ReturnType<DesktopControlPlaneApi["executeProviderUsage"]>>
    >((resolve) => {
      releaseRefresh = resolve;
    });
    let queryCount = 0;
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      if (command.command === "refresh") return pendingRefresh;
      queryCount += 1;
      return queryCount === 1
        ? {
            outcome: "ok",
            snapshot: {
              providers: [
                {
                  providerId: "aws-provider",
                  state: "unobserved",
                },
              ],
            },
          }
        : {
            outcome: "ok",
            snapshot: {
              providers: [
                {
                  providerId: "aws-provider",
                  state: "observed",
                  observedAt: 2,
                  refreshable: true,
                  windows: [{ kind: "weekly", usedPercent: 12 }],
                  budgets: [],
                },
              ],
            },
          };
    });
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
      onBackendState: (listener) => {
        backendListener = listener;
        return () => undefined;
      },
    });

    await act(async () => {
      usageRegion().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
    });

    const current = managedProfiles().state;
    await act(async () => {
      backendListener?.({
        kind: "ready",
        status: {
          modelDataPlane: "running",
          provider: "ready",
          credentialProfiles: {
            providers: current.providers.map((provider) => ({
              ...provider,
              revision: "revision-b",
              selectionGeneration: "selection-b",
              activeCredentialId: "credential-b",
              profiles: provider.profiles.map((profile) =>
                profile.credentialId === "credential-b"
                  ? { ...profile, health: "ready" as const }
                  : profile,
              ),
            })),
          },
        },
      } as never);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Week 12%");

    await act(async () => {
      releaseRefresh({
        outcome: "ok",
        snapshot: {
          providers: [
            {
              providerId: "aws-provider",
              state: "observed",
              observedAt: 3,
              refreshable: true,
              windows: [{ kind: "weekly", usedPercent: 90 }],
              budgets: [],
            },
          ],
        },
        refresh: {
          providerId: "aws-provider",
          outcome: "succeeded",
        },
      });
      await pendingRefresh;
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Week 12%");
    expect(container.textContent).not.toContain("Week 90%");
  });

  it("keeps Provider icon tooltips generic", async () => {
    await render({ profiles: managedProfiles() });
    const providerCard = container.querySelector(".provider-card");
    const titledButtons = [...(providerCard?.querySelectorAll("button[title]") ?? [])];

    expect(titledButtons.map((entry) => entry.getAttribute("title"))).toEqual(
      expect.arrayContaining([
        "Add API key",
        "Add OAuth account",
        "Manage models",
      ]),
    );
    expect(
      titledButtons.some((entry) => entry.getAttribute("title")?.includes("AWS Provider")),
    ).toBe(false);
    expect(
      ariaButton("Add AWS organization sign-in").querySelector(
        ".lucide-user-round-plus",
      ),
    ).not.toBeNull();
  });

  it("uses an icon-only action to refresh Provider models", async () => {
    await render({ profiles: managedProfiles() });
    const refreshModels = ariaButton("Refresh models");

    expect(refreshModels.getAttribute("title")).toBe("Refresh models");
    expect(refreshModels.textContent?.trim()).toBe("");
    expect(refreshModels.querySelector("svg")).not.toBeNull();
  });

  it("keeps Provider guidance behind a compact help action", async () => {
    await render({ profiles: managedProfiles() });

    expect(container.textContent).not.toContain("AI SERVICES");
    expect(container.textContent).not.toContain(
      "Find a provider, connect it, and manage the model names you use.",
    );
    expect(container.querySelector(".provider-page-heading h2")?.textContent).toBe(
      "Providers",
    );

    const toolbar = container.querySelector(".provider-toolbar");
    expect(toolbar?.querySelector('input[type="search"]')).not.toBeNull();
    expect(toolbar?.contains(ariaButton("Refresh models"))).toBe(true);
    expect(
      container.querySelector('[role="dialog"][aria-label="How to use Providers"]'),
    ).toBeNull();

    await clickAria("How to use Providers");
    const help = container.querySelector(
      '[role="dialog"][aria-label="How to use Providers"]',
    );
    expect(help?.textContent).toContain("Connect");
    expect(help?.textContent).toContain("Profiles");
    expect(help?.textContent).toContain("Models");

    await clickAria("Close Provider help");
    expect(
      container.querySelector('[role="dialog"][aria-label="How to use Providers"]'),
    ).toBeNull();
  });

  it("keeps orphaned persisted Profiles visible and removable", async () => {
    const orphan = managedProfiles();
    const orphanState = {
      ...orphan,
      state: {
        providers: orphan.state.providers.map((provider) => ({
          ...provider,
          providerId: "removed-provider",
          implementationAvailable: false,
        })),
      },
      options: { providers: [] },
    };
    await render({ profiles: orphanState });

    expect(container.textContent).toContain("removed-provider");
    expect(container.querySelector('[aria-label="Provider error"]')).not.toBeNull();
    await clickAria("Manage removed-provider profiles");
    await clickAria("More actions for Incident account");
    expect(container.textContent).toContain("Remove");
  });
});
