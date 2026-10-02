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
      acquisitionOptions: [
        {
          kind: "api_key" as const,
          label: "AWS credentials or bearer token",
          icon: "key" as const,
          authType: "api_key" as const,
          interactive: true,
          state: "available" as const,
        },
        {
          kind: "oauth" as const,
          label: "AWS organization sign-in",
          icon: "account" as const,
          authType: "oauth" as const,
          interactive: true,
          state: "available" as const,
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
            acquisitionKind: "api_key" as const,
            authMethodLabel: "AWS credentials or bearer token",
            displayName: "Production role",
            note: "Release traffic",
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            credentialId: "credential-b",
            authType: "oauth" as const,
            acquisitionKind: "oauth" as const,
            authMethodLabel: "AWS organization sign-in",
            displayName: "Incident account",
            enabled: true,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ],
  },
  options: providerOptions,
});

const notYetVerifiedProfiles = (): ProfilesResult =>
  managedProfiles();

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
          snapshot: { profiles: [] },
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
    const successText = new Date(1_725_000_000_000).toLocaleString();
    expect(container.textContent).not.toContain(successText);

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
    expect(container.textContent).toContain("active");
    expect(container.textContent).toContain(successText);
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
      providerCard?.querySelector(
        '.provider-card-actions [aria-label="1 published, 1 currently available"]',
      ),
    ).not.toBeNull();
    expect(
      providerCard?.querySelector('[aria-label="Active Profile 1 of 2"]'),
    ).not.toBeNull();
    expect(providerCard?.textContent).toContain("1/2");

    const manageProfiles = providerCard?.querySelector(
      'button[aria-label="Manage AWS Provider profiles"]',
    );
    expect(manageProfiles).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (manageProfiles as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-profile-id]")).toHaveLength(2);
    expect(container.textContent).toContain("AWS credentials or bearer token");
    expect(container.textContent).toContain("AWS organization sign-in");
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

  it("renders named Profiles with generic credential types and state in the secondary cards", async () => {
    await render({ profiles: managedProfiles() });
    await clickAria("Manage AWS Provider profiles");

    expect(container.textContent).toContain("Production role");
    expect(container.textContent).toContain("Incident account");
    expect(container.textContent).toContain("AWS credentials or bearer token");
    expect(container.textContent).toContain("AWS organization sign-in");
    expect(container.textContent).toContain("active");
    expect(container.textContent).toContain("enabled");
    expect(container.textContent).not.toContain("Use API key");
    expect(container.textContent).not.toContain("Account 1");
  });

  it("renders Profile actions inline on each Profile card", async () => {
    await render({ profiles: managedProfiles() });
    await clickAria("Manage AWS Provider profiles");

    const productionCard = container.querySelector(
      '[data-profile-id="credential-a"]',
    );
    const incidentCard = container.querySelector('[data-profile-id="credential-b"]');
    expect(
      productionCard?.querySelector('[aria-label="Rename Production role"]'),
    ).not.toBeNull();
    expect(
      productionCard?.querySelector('[aria-label="Disable Production role"]'),
    ).not.toBeNull();
    expect(
      productionCard?.querySelector('[aria-label="Remove Production role"]'),
    ).not.toBeNull();
    expect(
      incidentCard?.querySelector('[aria-label="Rename Incident account"]'),
    ).not.toBeNull();
    expect(
      incidentCard?.querySelector('[aria-label="Disable Incident account"]'),
    ).not.toBeNull();
    expect(
      incidentCard?.querySelector('[aria-label="Remove Incident account"]'),
    ).not.toBeNull();
    expect(
      productionCard?.querySelector(
        '.profile-card-power [aria-label="Disable Production role"]',
      ),
    ).not.toBeNull();
    expect(
      productionCard?.querySelector('[aria-label="Edit note for Production role"]'),
    ).not.toBeNull();
    expect(
      incidentCard?.querySelector('[aria-label="Edit note for Incident account"]'),
    ).not.toBeNull();
    expect(container.querySelector(".profile-actions-modal")).toBeNull();
    expect(container.textContent).not.toContain("Reconnect");
    expect(container.textContent).not.toContain("Recheck");
  });

  it("opens the Profile rename editor from the Profile name", async () => {
    await render({ profiles: managedProfiles() });
    await clickAria("Manage AWS Provider profiles");
    await clickAria("Rename Incident account");

    const incidentCard = container.querySelector(
      '[data-profile-id="credential-b"]',
    );
    const editor = incidentCard?.querySelector(".profile-metadata-editor");
    const input = editor?.querySelector("input");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect((input as HTMLInputElement).value).toBe("Incident account");
    expect(editor?.querySelector("textarea")).toBeNull();
  });

  it("saves an inline rename without changing the Profile note", async () => {
    const executeCredentialProfiles = vi.fn<
      DesktopControlPlaneApi["executeCredentialProfiles"]
    >(async () => managedProfiles());
    await render({ profiles: managedProfiles(), executeCredentialProfiles });
    await clickAria("Manage AWS Provider profiles");
    await clickAria("Rename Production role");

    const input = container.querySelector(
      '[data-profile-id="credential-a"] .profile-metadata-editor input',
    );
    expect(
      input,
    ).toBeInstanceOf(HTMLInputElement);
    await act(async () => {
      setInput(input as HTMLInputElement, "Primary renamed");
      input
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "update_metadata",
      providerId: "aws-provider",
      credentialId: "credential-a",
      expectedRevision: "revision-a",
      displayName: "Primary renamed",
      note: "Release traffic",
    });
  });

  it("saves an inline note edit without changing the Profile name", async () => {
    const executeCredentialProfiles = vi.fn<
      DesktopControlPlaneApi["executeCredentialProfiles"]
    >(async () => managedProfiles());
    await render({ profiles: managedProfiles(), executeCredentialProfiles });
    await clickAria("Manage AWS Provider profiles");
    await clickAria("Edit note for Incident account");

    const textarea = container.querySelector(
      '[data-profile-id="credential-b"] .profile-metadata-editor textarea',
    );
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    await act(async () => {
      setInput(textarea as HTMLTextAreaElement, "Escalation contact");
      textarea
        ?.closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "update_metadata",
      providerId: "aws-provider",
      credentialId: "credential-b",
      expectedRevision: "revision-a",
      displayName: "Incident account",
      note: "Escalation contact",
    });
  });

  it("searches sanitized Profile names, notes, and labels", async () => {
    await render({ profiles: managedProfiles() });
    const search = container.querySelector('input[type="search"]');
    expect(search).toBeInstanceOf(HTMLInputElement);

    await act(async () => setInput(search as HTMLInputElement, "incident"));
    expect(container.textContent).toContain("AWS Provider");
    await act(async () => setInput(search as HTMLInputElement, "release traffic"));
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
        acquisitionKind: "api_key",
        displayName: "Production role",
        note: "Release traffic",
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
    await clickAria("Disable Production role");
    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "set_enabled",
      providerId: "aws-provider",
      credentialId: "credential-a",
      expectedRevision: "revision-a",
      enabled: false,
    });

    await clickAria("Remove Incident account");
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

  it("places method-specific HTTP 429 switching in the Profiles dialog", async () => {
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
    expect(container.querySelector('[aria-label*="HTTP 429"]')).toBeNull();
    await clickAria("Close sign in");
    await clickAria("Manage AWS Provider profiles");
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

    await clickAria("Enable HTTP 429 Profile switching for AWS Provider AWS organization sign-in");
    expect(executeCredentialProfiles).toHaveBeenLastCalledWith({
      command: "set_switch_policy",
      providerId: "aws-provider",
      expectedRevision: "revision-a",
      apiKeyOn429: true,
      oauthOn429: true,
    });
  });

  it("does not expose HTTP 429 switching before the first Profile", async () => {
    await render();
    await clickAria("Add AWS credentials or bearer token");
    expect(container.querySelector('[aria-label*="HTTP 429"]')).toBeNull();
    await clickAria("Close sign in");
    expect(container.querySelector('[aria-label*="HTTP 429"]')).toBeNull();
  });

  it("shows the HTTP 429 switch only for auth branches that have Profiles", async () => {
    const singleBranch = managedProfiles();
    const provider = singleBranch.state.providers[0]!;
    provider.profiles = provider.profiles.filter(
      (profile) => profile.authType === "api_key",
    );
    await render({ profiles: singleBranch });
    await clickAria("Manage AWS Provider profiles");
    expect(ariaButton("Enable HTTP 429 Profile switching for AWS Provider AWS credentials or bearer token")).toBeTruthy();
    expect(container.querySelector('[aria-label*="HTTP 429 Profile switching for AWS Provider AWS organization sign-in"]')).toBeNull();
  });

  it("attributes cached usage to the exact active Profile and refreshes it explicitly", async () => {
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      if (command.command === "query") {
        return {
          outcome: "ok",
          snapshot: {
            profiles: [
              {
                providerId: "aws-provider",
                credentialId: "credential-a",
                state: "unobserved",
              },
            ],
          },
        };
      }
      return {
        outcome: "ok",
        snapshot: {
          profiles: [
            {
              providerId: "aws-provider",
              credentialId: "credential-a",
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
          credentialId: "credential-a",
          outcome: "succeeded",
        },
      };
    });
    await render({ profiles: managedProfiles(), executeProviderUsage });

    expect(executeProviderUsage).toHaveBeenCalledWith({ command: "query" });
    expect(container.textContent).toContain("Usage not refreshed");
    await doubleClickUsage();

    expect(executeProviderUsage).toHaveBeenCalledWith({
      command: "refresh",
      providerId: "aws-provider",
    });
    expect(container.textContent).toContain("Week 25%");
  });

  it("keeps each Profile's own usage on its own Profile card", async () => {
    await render({
      profiles: managedProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: {
          profiles: [
            {
              providerId: "aws-provider",
              credentialId: "credential-b",
              state: "observed",
              observedAt: 1,
              refreshable: true,
              windows: [{ kind: "weekly", usedPercent: 91 }],
              budgets: [],
            },
          ],
        },
      }),
    });

    expect(container.textContent).not.toContain("Week 91%");
    expect(container.textContent).toContain("Usage not refreshed");

    await clickAria("Manage AWS Provider profiles");
    const incidentCard = container.querySelector(
      '[data-profile-id="credential-b"]',
    );
    expect(incidentCard?.textContent).toContain("Week 91%");
  });

  it("shows each Profile's own usage and refreshes it by double click", async () => {
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async (command) => {
      const profiles = [
        {
          providerId: "aws-provider",
          credentialId: "credential-a",
          state: "observed" as const,
          observedAt: 1,
          refreshable: true,
          windows: [{ kind: "weekly" as const, usedPercent: 25 }],
          budgets: [],
        },
        {
          providerId: "aws-provider",
          credentialId: "credential-b",
          state: "observed" as const,
          observedAt: 1,
          refreshable: true,
          windows: [
            {
              kind: "weekly" as const,
              usedPercent: command.command === "refresh" ? 92 : 91,
              resetAt: Date.now() + 3_600_000,
            },
          ],
          budgets: [],
        },
      ];
      return command.command === "refresh"
        ? {
            outcome: "ok" as const,
            snapshot: { profiles },
            refresh: {
              providerId: "aws-provider",
              credentialId: "credential-b",
              outcome: "succeeded" as const,
            },
          }
        : { outcome: "ok" as const, snapshot: { profiles } };
    });
    await render({ profiles: managedProfiles(), executeProviderUsage });
    await clickAria("Manage AWS Provider profiles");

    const productionCard = container.querySelector(
      '[data-profile-id="credential-a"]',
    );
    const incidentCard = container.querySelector(
      '[data-profile-id="credential-b"]',
    );
    expect(productionCard?.textContent).toContain("Week 25%");
    expect(incidentCard?.textContent).toContain("Week 91%");
    expect(incidentCard?.textContent).toContain("Week resets in 1h");

    const usage = incidentCard?.querySelector(
      '.profile-card-usage[role="button"]',
    );
    expect(usage).toBeInstanceOf(HTMLElement);
    await act(async () => {
      usage?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
    });
    expect(executeProviderUsage).toHaveBeenCalledWith({
      command: "refresh",
      providerId: "aws-provider",
      credentialId: "credential-b",
    });
    expect(incidentCard?.textContent).toContain("Week 92%");
  });

  it("clears displayed usage when active Profile selection changes", async () => {
    let backendListener:
      | Parameters<DesktopControlPlaneApi["onBackendState"]>[0]
      | undefined;
    const executeProviderUsage = vi.fn<
      DesktopControlPlaneApi["executeProviderUsage"]
    >(async () => ({
      outcome: "ok",
      snapshot: {
        profiles: [
          {
            providerId: "aws-provider",
            credentialId: "credential-a",
            state: "observed",
            observedAt: 1,
            refreshable: true,
            windows: [{ kind: "weekly", usedPercent: 90 }],
            budgets: [],
          },
        ],
      },
    }));
    await render({
      profiles: managedProfiles(),
      executeProviderUsage,
      onBackendState: (listener) => {
        backendListener = listener;
        return () => undefined;
      },
    });
    expect(container.textContent).toContain("Week 90%");

    const current = managedProfiles().state;
    await act(async () => {
      backendListener?.({
        kind: "ready",
        status: {
          modelDataPlane: "running",
          provider: "configured",
          credentialProfiles: {
            providers: current.providers.map((provider) => ({
              ...provider,
              revision: "revision-b",
              selectionGeneration: "selection-b",
              activeCredentialId: "credential-b",
            })),
          },
        },
      } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("Week 90%");
  });

  it("hides usage when a Provider has no active Profile", async () => {
    await render({
      profiles: emptyProfiles(),
      executeProviderUsage: async () => ({
        outcome: "ok",
        snapshot: { profiles: [] },
      }),
    });

    expect(
      container.querySelector('[aria-label^="AWS Provider usage"]'),
    ).toBeNull();
  });

  it("keeps Provider icon tooltips generic", async () => {
    await render({ profiles: managedProfiles() });
    const providerCard = container.querySelector(".provider-card");
    const titledButtons = [...(providerCard?.querySelectorAll("button[title]") ?? [])];

    expect(titledButtons.map((entry) => entry.getAttribute("title"))).toEqual(
      expect.arrayContaining([
        "Add AWS credentials or bearer token",
        "Add AWS organization sign-in",
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
    expect(
      container.querySelector('[aria-label="Remove Incident account"]'),
    ).not.toBeNull();
  });
});
