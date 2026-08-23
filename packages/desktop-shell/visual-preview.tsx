import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./src/renderer/app/App.js";
import "./src/renderer/renderer.css";
import { createFakeDesktopApi } from "./test/support/fake-desktop-api.js";

const providerSpecs = [
  ["commandcode-goat", "CommandCode Goat", true],
  ["commandcode-private", "CommandCode Private", true],
  ["opencode-go", "OpenCode Go", true],
  ["amazon-bedrock", "Amazon Bedrock", false],
  ["anthropic", "Anthropic", false],
  ["azure-openai", "Azure OpenAI", false],
] as const;

const profilesByProvider = new Map<string, any>([
  [
    "commandcode-goat",
    {
      providerId: "commandcode-goat",
      implementationAvailable: true,
      revision: "goat-r1",
      selectionGeneration: "goat-s1",
      activeCredentialId: "goat-profile-1",
      switchPolicy: { apiKeyOn429: true, oauthOn429: true },
      profiles: [
        {
          credentialId: "goat-profile-1",
          authType: "api_key",
          authMethodLabel: "CommandCode Goat API key",
          displayName: "Profile 1",
          note: "Daily coding",
          identityHint: "•••• WmRW",
          enabled: true,
          health: "ready",
          priority: 0,
          createdAt: 1,
          updatedAt: 1,
          lastSucceededAt: Date.now() - 25_000,
        },
      ],
    },
  ],
  [
    "commandcode-private",
    {
      providerId: "commandcode-private",
      implementationAvailable: true,
      revision: "private-r1",
      selectionGeneration: "private-s1",
      activeCredentialId: "private-profile-1",
      switchPolicy: { apiKeyOn429: true, oauthOn429: true },
      profiles: [
        {
          credentialId: "private-profile-1",
          authType: "api_key",
          authMethodLabel: "CommandCode API key",
          displayName: "Profile 1",
          note: "Production key",
          identityHint: "•••• 7K2P",
          enabled: true,
          health: "ready",
          priority: 0,
          createdAt: 1,
          updatedAt: 1,
          lastSucceededAt: Date.now() - 40_000,
        },
        {
          credentialId: "private-profile-2",
          authType: "oauth",
          authMethodLabel: "CommandCode account login",
          displayName: "Profile 2",
          note: "Personal account",
          identityHint: "huich@example.com",
          enabled: true,
          health: "ready",
          priority: 1,
          createdAt: 2,
          updatedAt: 2,
          lastSucceededAt: Date.now() - 85_000,
        },
      ],
    },
  ],
  [
    "opencode-go",
    {
      providerId: "opencode-go",
      implementationAvailable: true,
      revision: "opencode-r1",
      selectionGeneration: "opencode-s1",
      activeCredentialId: "opencode-profile-1",
      switchPolicy: { apiKeyOn429: false, oauthOn429: false },
      profiles: [
        {
          credentialId: "opencode-profile-1",
          authType: "api_key",
          authMethodLabel: "OpenCode API key",
          displayName: "Profile 1",
          identityHint: "•••• 2TmR",
          enabled: true,
          health: "ready",
          priority: 0,
          createdAt: 1,
          updatedAt: 1,
          lastSucceededAt: Date.now() - 60_000,
        },
      ],
    },
  ],
]);

for (const [providerId] of providerSpecs) {
  if (!profilesByProvider.has(providerId)) {
    profilesByProvider.set(providerId, {
      providerId,
      implementationAvailable: true,
      revision: "absent",
      ambient: {
        kind: "external",
        status: "unknown",
        message: "External authentication resolves when the Provider is used",
      },
      profiles: [],
    });
  }
}

const options = {
  providers: providerSpecs.map(([providerId, name]) => ({
    providerId,
    name,
    source: "pi_builtin",
    authMethods: [
      {
        authType: "api_key",
        authMethodLabel: `${name} API key`,
        interactive: true,
      },
      {
        authType: "oauth",
        authMethodLabel: `${name} account login`,
        interactive: true,
      },
    ],
  })),
};

const publicProviders = providerSpecs.map(([providerId, , connected], providerIndex) => ({
  providerId,
  on: connected,
  favorite: providerId === "commandcode-private",
  models: Array.from({ length: providerIndex < 3 ? 4 : 3 }, (_, modelIndex) => ({
    alias: `${providerId}/${["sonnet-4.5", "opus-4.1", "gpt-5.2", "gemini-3-pro"][modelIndex] ?? `model-${modelIndex + 1}`}`,
    target: `${providerId}-model-${modelIndex + 1}`,
    on: connected || modelIndex === 0,
    favorite: modelIndex === 1,
  })),
}));

const publicState = {
  revision: 8,
  version: 4,
  endpoint: { host: "127.0.0.1", port: 4317 },
  providers: publicProviders,
};

const catalogSnapshot = {
  version: 4,
  modelsJsonValid: true,
  providers: providerSpecs.map(([providerId, name], providerIndex) => ({
    providerId,
    name,
    dynamic: false,
    state: "succeeded",
    models: Array.from({ length: providerIndex < 3 ? 4 : 3 }, (_, modelIndex) => ({
      id: `${providerId}-model-${modelIndex + 1}`,
      dynamic: false,
      availability: modelIndex === 3 ? "unavailable" : "available",
    })),
  })),
  refreshErrors: [],
};

const profilesResult = () => ({
  outcome: "ok",
  state: { providers: [...profilesByProvider.values()] },
  options,
});

const api = createFakeDesktopApi({
  control: {
    getBackendState: async () => ({
      revision: 1,
      kind: "ready",
      status: {
        sequence: 1,
        modelDataPlane: "running",
        provider: "configured",
        dataPlane: {
          configuredOrigin: "http://127.0.0.1:4317",
          configuredPort: 4317,
        },
      },
    } as any),
    onBackendState: () => () => undefined,
    executeRuntime: async (command) => ({ command, outcome: "completed", snapshot: {} } as any),
    executeCredentialProfiles: async (command: any) => {
      if (command.command === "set_switch_policy") {
        const provider = profilesByProvider.get(command.providerId);
        if (provider !== undefined) {
          provider.switchPolicy = {
            apiKeyOn429: command.apiKeyOn429,
            oauthOn429: command.oauthOn429,
          };
        }
      }
      if (command.command === "reorder_profiles") {
        const provider = profilesByProvider.get(command.providerId);
        if (provider !== undefined) {
          const byId = new Map(provider.profiles.map((profile: any) => [profile.credentialId, profile]));
          provider.profiles = command.credentialIds.map((id: string, index: number) => ({
            ...byId.get(id),
            priority: index,
          }));
        }
      }
      return profilesResult() as any;
    },
    executeProviderProfileAuth: async () => profilesResult() as any,
    respondAuth: async () => undefined,
    executeCatalog: async () => ({ outcome: "ok", snapshot: catalogSnapshot } as any),
    executePublicModels: async (command: any) => {
      if (command.command === "rename_model" || command.command === "restore_model_name") {
        const provider = publicProviders.find((entry) => entry.providerId === command.providerId);
        const model = provider?.models.find((entry) => entry.target === command.modelId);
        if (model !== undefined) {
          const modelName = command.command === "rename_model" ? command.modelName : command.modelId;
          model.alias = `${command.providerId}/${modelName}`;
        }
      }
      if (command.command === "reorder_models") {
        const provider = publicProviders.find((entry) => entry.providerId === command.providerId);
        if (provider !== undefined) {
          const byId = new Map(provider.models.map((model) => [model.target, model]));
          provider.models = command.modelIds.map((id: string) => byId.get(id)!);
        }
      }
      return { outcome: "ok", state: { ...publicState, revision: publicState.revision++ } } as any;
    },
    executeAgentIntegrations: async () => ({
      outcome: "ok",
      state: {
        revision: 1,
        agents: [
          { agentId: "codex", enabled: true, scope: "favorite", needsSync: false },
          { agentId: "pi", enabled: false, scope: "favorite", needsSync: false },
        ],
      },
      results: [],
    } as any),
    getRequestLedger: async () => ({ records: [], hasMore: false }),
    onRequestLedger: () => () => undefined,
  },
});

const root = document.getElementById("root");
if (root === null) throw new Error("Visual preview root is missing");

createRoot(root).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
