import {
  createAssistantMessageEventStream,
  createProvider,
  type AssistantMessage,
  type AuthContext,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";

/**
 * Ticket 12 fixture: a builtin-like Provider whose ambient API-key source is
 * one environment variable, mirroring the shape of Pi builtins (anthropic
 * reads ANTHROPIC_API_KEY etc.). The check is side-effect free: env lookup
 * only, never commands/network.
 */
export function createFixtureProvider(
  options: {
    readonly id?: string;
    readonly name?: string;
    readonly envVarName?: string;
  } = {},
): Provider {
  const id = options.id ?? "fixture-provider";
  const envVarName = options.envVarName ?? "FIXTURE_API_KEY";
  const model: Model<"fixture-api"> = {
    id: "fixture-model",
    name: "Fixture Model",
    api: "fixture-api",
    provider: id,
    baseUrl: "https://fixture.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
  const stream = (selected: Model<"fixture-api">) => {
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "fixture" }],
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
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
  return createProvider({
    id,
    name: options.name ?? "Fixture Provider",
    models: [model],
    auth: {
      apiKey: {
        name: "Fixture API key",
        login: async (interaction) => ({
          type: "api_key",
          key: await interaction.prompt({
            type: "secret",
            message: "Enter the fixture API key",
          }),
        }),
        check: async ({ ctx, credential }) => {
          if (credential?.key !== undefined && credential.key !== "") {
            return { type: "api_key", source: "stored credential" };
          }
          return (await ctx.env(envVarName)) === undefined
            ? undefined
            : { type: "api_key", source: envVarName };
        },
        resolve: async ({ ctx, credential }) => {
          if (credential?.key) {
            return {
              auth: { apiKey: credential.key },
              ...(credential.env === undefined ? {} : { env: credential.env }),
              source: "stored credential",
            };
          }
          const ambient = await ctx.env(envVarName);
          return ambient === undefined
            ? undefined
            : { auth: { apiKey: ambient }, source: envVarName };
        },
      },
    },
    api: { stream, streamSimple: stream },
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
