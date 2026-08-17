import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AuthContext,
  type AuthPrompt,
  type Model,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";

/**
 * Ticket 13 fixture: controlled Providers whose login flows exercise every
 * typed AuthInteraction event/prompt shape. Deterministic, no network:
 * "authorization" is a fixed fake code, device polling is a fixed expiry,
 * and credentials carry fake values that tests assert against the on-disk
 * auth.json bytes.
 */

function fixtureModel(providerId: string): Model<"fixture-api"> {
  return {
    id: "fixture-model",
    name: "Fixture Model",
    api: "fixture-api",
    provider: providerId,
    baseUrl: "https://fixture.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
}

function fixtureApi(providerId: string) {
  const stream = () => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "fixture" }],
      api: "fixture-api",
      provider: providerId,
      model: "fixture-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    events.push({ type: "start", partial: message });
    events.push({ type: "done", reason: "stop", message });
    events.end(message);
    return events;
  };
  return { stream, streamSimple: stream };
}

/** The fake authorization code that completes every controlled browser
 *  flow; its exact bytes must never reach any projection. */
export const FAKE_AUTH_CODE = "auth-code-controlled";

export function fakeOAuthCredential(access: string): OAuthCredential {
  return {
    type: "oauth",
    refresh: `refresh-${access}`,
    access,
    expires: Date.now() + 3_600_000,
  };
}

/** OAuth browser flow: notifies an auth_url, races a manual_code prompt
 *  against the "callback" (the test answers the prompt), exchanges the code
 *  and completes. Emits info and progress events. */
export function createBrowserOAuthProvider(
  options: {
    readonly id?: string;
    readonly name?: string;
    readonly isSubscription?: boolean;
    readonly loginLabel?: string;
  } = {},
): Provider {
  const id = options.id ?? "browser-provider";
  return createProvider({
    id,
    name: options.name ?? "Browser Provider",
    models: [fixtureModel(id)],
    auth: {
      apiKey: {
        name: "Browser Provider API key",
        resolve: async () => undefined,
      },
      oauth: {
        name: "Browser Provider Account",
        ...(options.isSubscription === undefined
          ? {}
          : { isSubscription: options.isSubscription }),
        ...(options.loginLabel === undefined
          ? {}
          : { loginLabel: options.loginLabel }),
        async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
          interaction.notify({
            type: "info",
            message: "Sign-in will open a browser",
            links: [{ url: "https://fixture.invalid/help", label: "Help" }],
          });
          interaction.notify({
            type: "auth_url",
            url: "https://fixture.invalid/authorize?client_id=fixture&state=fixture-state",
            instructions: "Complete sign-in in your browser, or paste the code here",
          });
          interaction.notify({
            type: "progress",
            message: "Waiting for the authorization code",
          });
          const input = await interaction.prompt({
            type: "manual_code",
            message: "Paste the authorization code or redirect URL",
            placeholder: "https://fixture.invalid/callback",
          });
          interaction.notify({
            type: "progress",
            message: "Exchanging the authorization code",
          });
          if (input.trim() !== FAKE_AUTH_CODE) {
            throw new Error("Authorization code was rejected");
          }
          return fakeOAuthCredential(`access-${id}`);
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    api: fixtureApi(id),
  });
}

/** OAuth device-code flow: notifies the device_code event with a user code
 *  and verification URI, waits for the test to answer a text prompt, then
 *  completes. */
export function createDeviceCodeOAuthProvider(
  options: { readonly id?: string } = {},
): Provider {
  const id = options.id ?? "device-provider";
  return createProvider({
    id,
    name: "Device Provider",
    models: [fixtureModel(id)],
    auth: {
      apiKey: {
        name: "Device Provider API key",
        resolve: async () => undefined,
      },
      oauth: {
        name: "Device Provider Account",
        async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
          interaction.notify({
            type: "device_code",
            userCode: "FAKE-USER-CODE",
            verificationUri: "https://fixture.invalid/verify",
            intervalSeconds: 5,
            expiresInSeconds: 600,
          });
          const confirmation = await interaction.prompt({
            type: "text",
            message: "Enter CONFIRM after signing in on the verification page",
          });
          if (confirmation.trim() !== "CONFIRM") {
            throw new Error("Device sign-in was not confirmed");
          }
          return fakeOAuthCredential(`access-${id}`);
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    api: fixtureApi(id),
  });
}

/** OAuth flow that starts with a select prompt (login method choice). */
export function createSelectOAuthProvider(
  options: { readonly id?: string } = {},
): Provider {
  const id = options.id ?? "select-provider";
  return createProvider({
    id,
    name: "Select Provider",
    models: [fixtureModel(id)],
    auth: {
      apiKey: {
        name: "Select Provider API key",
        resolve: async () => undefined,
      },
      oauth: {
        name: "Select Provider Account",
        async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
          const method = await interaction.prompt({
            type: "select",
            message: "Select a sign-in method",
            options: [
              { id: "browser", label: "Browser", description: "Recommended" },
              { id: "device", label: "Device code" },
            ],
          });
          if (method !== "browser") {
            throw new Error(`Unsupported method: ${method}`);
          }
          return fakeOAuthCredential(`access-${id}`);
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    api: fixtureApi(id),
  });
}

/** API-key provider whose interactive login prompts for a secret. */
export function createSecretApiKeyProvider(
  options: { readonly id?: string } = {},
): Provider {
  const id = options.id ?? "secret-provider";
  return createProvider({
    id,
    name: "Secret Provider",
    models: [fixtureModel(id)],
    auth: {
      apiKey: {
        name: "Secret Provider API key",
        login: async (interaction: ProviderAuthInteraction) => ({
          type: "api_key",
          key: await interaction.prompt({
            type: "secret",
            message: "Enter the secret API key",
          }),
        }),
        resolve: async ({ credential }) =>
          credential?.key === undefined
            ? undefined
            : { auth: { apiKey: credential.key }, source: "stored credential" },
      },
    },
    api: fixtureApi(id),
  });
}

/** API-key provider whose interactive login prompts for a text value and
 *  supports ambient resolution from one environment variable. */
export function createAmbientApiKeyProvider(
  options: { readonly id?: string } = {},
): Provider {
  const id = options.id ?? "ambient-provider";
  return createProvider({
    id,
    name: "Ambient Provider",
    models: [fixtureModel(id)],
    auth: {
      apiKey: {
        name: "Ambient Provider API key",
        login: async (interaction: ProviderAuthInteraction) => ({
          type: "api_key",
          key: await interaction.prompt({
            type: "text",
            message: "Enter the ambient API key",
          }),
        }),
        check: async ({ ctx }) =>
          (await ctx.env("AMBIENT_API_KEY")) === undefined
            ? undefined
            : { type: "api_key", source: "AMBIENT_API_KEY" },
        resolve: async ({ ctx, credential }) => {
          if (credential?.key !== undefined) {
            return { auth: { apiKey: credential.key }, source: "stored credential" };
          }
          const ambient = await ctx.env("AMBIENT_API_KEY");
          return ambient === undefined
            ? undefined
            : { auth: { apiKey: ambient }, source: "AMBIENT_API_KEY" };
        },
      },
    },
    api: fixtureApi(id),
  });
}

/** OAuth provider whose refresh always fails (invalid grant): the stored
 *  credential must be preserved for retry, never deleted. */
export function createExpiredOAuthProvider(
  options: { readonly id?: string } = {},
): Provider {
  const id = options.id ?? "expired-provider";
  const base = createBrowserOAuthProvider({ id, name: "Expired Provider" });
  return {
    ...base,
    auth: {
      ...base.auth,
      oauth: {
        ...(base.auth.oauth as NonNullable<typeof base.auth.oauth>),
        refresh: async () => {
          throw new Error("invalid_grant: refresh token expired");
        },
      },
    },
  };
}

/** OAuth provider whose login always fails after a progress event. */
export function createFailingOAuthProvider(
  options: { readonly id?: string } = {},
): Provider {
  const id = options.id ?? "failing-provider";
  return createProvider({
    id,
    name: "Failing Provider",
    models: [fixtureModel(id)],
    auth: {
      apiKey: {
        name: "Failing Provider API key",
        resolve: async () => undefined,
      },
      oauth: {
        name: "Failing Provider Account",
        async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
          interaction.notify({ type: "progress", message: "Starting sign-in" });
          throw new Error("Upstream sign-in rejected the request");
        },
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    api: fixtureApi(id),
  });
}

/** A provider without any interactive login (ambient-only). */
export function createAmbientOnlyProvider(
  options: { readonly id?: string } = {},
): Provider {
  const id = options.id ?? "ambient-only-provider";
  return createProvider({
    id,
    name: "Ambient Only Provider",
    models: [fixtureModel(id)],
    auth: {
      apiKey: {
        name: "Ambient Only API key",
        check: async ({ ctx }) =>
          (await ctx.env("AMBIENT_ONLY_KEY")) === undefined
            ? undefined
            : { type: "api_key", source: "AMBIENT_ONLY_KEY" },
        resolve: async ({ ctx }) => {
          const ambient = await ctx.env("AMBIENT_ONLY_KEY");
          return ambient === undefined
            ? undefined
            : { auth: { apiKey: ambient }, source: "AMBIENT_ONLY_KEY" };
        },
      },
    },
    api: fixtureApi(id),
  });
}

/** Deterministic auth context over a plain record (never process.env). */
export function createFixtureAuthContext(
  env: Readonly<Record<string, string>>,
): AuthContext {
  return Object.freeze({
    env: async (name: string) => env[name],
    fileExists: async () => false,
  });
}

/** Returns the prompt kinds a provider's login asked for, in order. */
export function promptKinds(prompts: readonly AuthPrompt[]): string[] {
  return prompts.map((prompt) => prompt.type);
}
