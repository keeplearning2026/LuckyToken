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
      executePublicModels: async () => publicModels(),
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

async function click(name: string): Promise<void> {
  await act(async () => {
    button(name).click();
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
  it("renders Backend auth labels, named Profiles, notes, and health without API-key ontology", async () => {
    await render({ profiles: managedProfiles() });

    expect(container.textContent).toContain("AWS credentials or bearer token");
    expect(container.textContent).toContain("Production role");
    expect(container.textContent).toContain("Release traffic");
    expect(container.textContent).toContain("Incident account");
    expect(container.textContent).toContain("reconnect required");
    expect(container.textContent).not.toContain("Use API key");
    expect(container.textContent).not.toContain("Account 1");
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

    await click("Add AWS credentials or bearer token");
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

    await click("Disable");
    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "set_enabled",
      providerId: "aws-provider",
      credentialId: "credential-a",
      expectedRevision: "revision-a",
      enabled: false,
    });

    await click("Disconnect from LuckyToken");
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

  it("uses Provider labels in independent HTTP 429 settings", async () => {
    const executeCredentialProfiles = vi.fn(async () => managedProfiles());
    await render({ profiles: managedProfiles(), executeCredentialProfiles });
    const setting = [...container.querySelectorAll("label")].find((label) =>
      label.textContent?.includes(
        "Try the next AWS credentials or bearer token after HTTP 429",
      ),
    )?.querySelector('input[type="checkbox"]');
    expect(setting).toBeInstanceOf(HTMLInputElement);
    await act(async () => (setting as HTMLInputElement).click());

    expect(executeCredentialProfiles).toHaveBeenCalledWith({
      command: "set_switch_policy",
      providerId: "aws-provider",
      expectedRevision: "revision-a",
      apiKeyOn429: true,
      oauthOn429: false,
    });
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
    expect(container.textContent).toContain("Provider unavailable");
    expect(container.textContent).toContain("Remove from LuckyToken");
  });
});
