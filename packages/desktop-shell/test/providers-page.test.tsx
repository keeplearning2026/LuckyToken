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
          { id: "model-a", dynamic: true, availability: "available" as const },
          { id: "model-b", dynamic: true, availability: "unavailable" as const },
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
  readonly profiles?: ProfilesResult;
  readonly executeCredentialProfiles?: DesktopControlPlaneApi["executeCredentialProfiles"];
  readonly executeProviderProfileAuth?: DesktopControlPlaneApi["executeProviderProfileAuth"];
  readonly executePublicModels?: DesktopControlPlaneApi["executePublicModels"];
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
      executeCatalog: async () => catalog(),
      executePublicModels:
        options.executePublicModels ?? (async () => publicModels()),
      onRequestJourneys:
        options.onRequestJourneys ?? (() => () => undefined),
      respondAuth: async () => undefined,
    },
  });
  await act(async () => {
    root.render(<ProvidersPage api={api} />);
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

  it("opens one cross-Provider list containing only favorite models", async () => {
    await render({ profiles: managedProfiles() });

    const favorites = container.querySelector(
      'button[aria-label="Show favorite models (1)"]',
    );
    expect(favorites).toBeInstanceOf(HTMLButtonElement);
    expect(favorites?.querySelector(".provider-favorite-model-count")?.textContent).toBe("1");

    await act(async () => {
      (favorites as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const dialog = container.querySelector(
      '[role="dialog"][aria-label="Favorite models"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("model-beta");
    expect(dialog?.textContent).toContain("Provider: AWS Provider");
    expect(dialog?.textContent).not.toContain("model-a");
    expect(
      dialog?.querySelector('[data-model-id="model-b"]')?.getAttribute("draggable"),
    ).toBe("false");
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
    expect(
      container.querySelector('button[aria-label="Rename model-beta"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Rename");
    expect(container.textContent).not.toContain("Published");
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

  it("adds a named Profile through the typed Profile auth command", async () => {
    const executeProviderProfileAuth = vi.fn(async () => managedProfiles());
    await render({ executeProviderProfileAuth });

    await clickAria("Add AWS credentials or bearer token");
    const name = container.querySelector('input[maxlength="64"]');
    const note = container.querySelector('textarea[maxlength="200"]');
    expect(name).toBeInstanceOf(HTMLInputElement);
    expect(note).toBeInstanceOf(HTMLTextAreaElement);
    expect((name as HTMLInputElement).value).toBe("Profile 1");
    await act(async () => {
      setInput(name as HTMLInputElement, "Production role");
      setInput(note as HTMLTextAreaElement, "Release traffic");
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

  it("uses one visibly stateful icon toggle for the Provider HTTP 429 fallback policy", async () => {
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
    const fallback = ariaButton("Enable HTTP 429 fallback for AWS Provider");
    expect(fallback.getAttribute("aria-pressed")).toBe("false");
    const initialTitle = fallback.getAttribute("title");
    await clickAria("Enable HTTP 429 fallback for AWS Provider");

    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "set_switch_policy",
      providerId: "aws-provider",
      expectedRevision: "revision-a",
      apiKeyOn429: true,
      oauthOn429: true,
    });
    const enabledFallback = ariaButton("Disable HTTP 429 fallback for AWS Provider");
    expect(enabledFallback.getAttribute("aria-pressed")).toBe("true");
    expect(enabledFallback.classList.contains("active")).toBe(true);
    expect(initialTitle).toBe("Enable HTTP 429 fallback");
    expect(enabledFallback.getAttribute("title")).toBe("Disable HTTP 429 fallback");
  });

  it("keeps Provider icon tooltips generic", async () => {
    await render({ profiles: managedProfiles() });
    const providerCard = container.querySelector(".provider-card");
    const titledButtons = [...(providerCard?.querySelectorAll("button[title]") ?? [])];

    expect(titledButtons.map((entry) => entry.getAttribute("title"))).toEqual(
      expect.arrayContaining([
        "Enable HTTP 429 fallback",
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
