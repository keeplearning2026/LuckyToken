import type {
  Api,
  ApiKeyAuth,
  AuthContext,
  AuthResult,
  Model,
  Models,
  OAuthAuth,
  Provider,
  ProviderAuth,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  InMemoryCredentialStore,
  ModelsError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { createConfigValueResolver } from "../../src/providers/config-value.js";
import {
  composeConfiguredAuth,
  createRequestCompositionModels,
  mergeHeaders,
  resolveConfiguredModelHeaders,
  resolveRequestModel,
} from "../../src/providers/request-composition.js";
import type { ModelsJsonProviderConfig } from "../../src/providers/models-json.js";

/**
 * Ticket 10 request-time composition seam.
 *
 * Mirrors the pinned Pi request composition
 * (`pi-agent/packages/coding-agent/src/core/provider-composer.ts` +
 * `model-runtime.ts` in @earendil-works/pi-coding-agent 0.84.2): stored
 * credential, then configured models.json key (literal/env/!command,
 * resolved per request), then built-in/inherited auth; provider headers
 * merge into the auth result; authHeader adds `Authorization: Bearer` only
 * at the Provider-facing boundary; model-level configured headers merge
 * case-insensitively above auth and built-in model headers.
 *
 * All env and command sources are injected deterministic adapters; no real
 * shell command ever runs.
 */
describe("request-time auth and header composition", () => {
  function envCtx(env: Readonly<Record<string, string>>): AuthContext {
    return {
      env: async (name) => env[name],
      fileExists: async () => false,
    };
  }

  function recordingApiKeyAuth(
    overrides: Partial<ApiKeyAuth> = {},
  ): ApiKeyAuth & {
    readonly calls: Array<{ input: Parameters<NonNullable<ApiKeyAuth["resolve"]>>[0] }>;
  } {
    const calls: Array<{ input: Parameters<NonNullable<ApiKeyAuth["resolve"]>>[0] }> = [];
    const auth: ApiKeyAuth = {
      name: "base auth",
      resolve: async (input) => {
        calls.push({ input });
        return { auth: { apiKey: "sk-base" }, source: "base" };
      },
      ...overrides,
    };
    return Object.assign(auth, { calls });
  }

  function model(id: string, headers?: Record<string, string>): Model<Api> {
    return {
      id,
      name: id,
      api: "anthropic-messages",
      provider: "gw",
      baseUrl: "https://gw.example.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
      ...(headers === undefined ? {} : { headers }),
    };
  }

  function providerWith(
    id: string,
    auth: ProviderAuth,
    models: readonly Model<Api>[],
    recordings: Array<{ model: Model<Api>; options?: SimpleStreamOptions }>,
  ): Provider {
    return createProvider({
      id,
      name: id,
      auth,
      models,
      api: {
        streamSimple: (streamModel, _context, options) => {
          recordings.push({
            model: streamModel,
            ...(options === undefined ? {} : { options }),
          });
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            api: streamModel.api,
            provider: streamModel.provider,
            model: streamModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
          };
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return stream;
        },
        stream: () => {
          throw new Error("unused");
        },
      },
    });
  }

  function config(providerConfig: ModelsJsonProviderConfig) {
    return { providers: { gw: providerConfig } };
  }

  function adapters(
    env: Readonly<Record<string, string>> = {},
    commands: Readonly<Record<string, string>> = {},
    runs: Array<{ command: string }> = [],
  ) {
    return {
      configValues: createConfigValueResolver({
        envSource: (name) => env[name],
        commandRunner: (command) => {
          runs.push({ command });
          const output = commands[command];
          return output === undefined ? undefined : output.trim() || undefined;
        },
      }),
      runs,
    };
  }

  describe("mergeHeaders", () => {
    it("keeps the base when there is no override and vice versa", () => {
      expect(mergeHeaders(undefined, undefined)).toBeUndefined();
      expect(mergeHeaders({ a: "1" }, undefined)).toEqual({ a: "1" });
      expect(mergeHeaders(undefined, { a: "1" })).toEqual({ a: "1" });
    });

    it("overrides case-insensitively: same name in different casing collapses", () => {
      expect(mergeHeaders({ "X-API-KEY": "base" }, { "x-api-key": "override" })).toEqual({
        "x-api-key": "override",
      });
      expect(mergeHeaders({ "X-A": "1", b: "2" }, { B: "3" })).toEqual({ "X-A": "1", B: "3" });
    });
  });

  describe("composeConfiguredAuth — apiKey", () => {
    it("resolves a configured literal key with the pinned source label", async () => {
      const { apiKey } = composeConfiguredAuth(
        "gw",
        undefined,
        config({ apiKey: "sk-literal" }).providers.gw,
        adapters(),
      );
      const result = await apiKey!.resolve({ ctx: envCtx({}), signal: new AbortController().signal });
      expect(result).toEqual({ auth: { apiKey: "sk-literal" }, source: "configured API key" });
    });

    it("resolves an env-template key per request through the auth context", async () => {
      const env: Record<string, string> = { GW_KEY: "k1" };
      const composed = composeConfiguredAuth(
        "gw",
        undefined,
        config({ apiKey: "$GW_KEY" }).providers.gw,
        adapters(env),
      );
      const resolve = (): Promise<AuthResult | undefined> =>
        composed.apiKey!.resolve({ ctx: envCtx(env), signal: new AbortController().signal });
      expect(await resolve()).toMatchObject({ auth: { apiKey: "k1" } });
      env.GW_KEY = "k2";
      expect(await resolve()).toMatchObject({ auth: { apiKey: "k2" } });
    });

    it("runs a !command key per request through the injected runner", async () => {
      const commands: Record<string, string> = { "fetch-key": "c1" };
      const { runs } = adapters({}, commands);
      const composed = composeConfiguredAuth(
        "gw",
        undefined,
        config({ apiKey: "!fetch-key" }).providers.gw,
        adapters({}, commands, runs),
      );
      const resolve = (): Promise<AuthResult | undefined> =>
        composed.apiKey!.resolve({ ctx: envCtx({}), signal: new AbortController().signal });
      expect(await resolve()).toMatchObject({ auth: { apiKey: "c1" } });
      commands["fetch-key"] = "c2";
      expect(await resolve()).toMatchObject({ auth: { apiKey: "c2" } });
      expect(runs).toEqual([{ command: "fetch-key" }, { command: "fetch-key" }]);
    });

    it("prefers the stored credential, and a stored credential flows to the inherited auth", async () => {
      // Custom provider (no inherited auth): the stored credential wins
      // directly with the pinned source label.
      const custom = composeConfiguredAuth(
        "gw",
        undefined,
        config({ apiKey: "sk-configured" }).providers.gw,
        adapters(),
      );
      const direct = await custom.apiKey!.resolve({
        ctx: envCtx({}),
        credential: { type: "api_key", key: "sk-stored" },
        signal: new AbortController().signal,
      });
      expect(direct).toEqual({
        auth: { apiKey: "sk-stored" },
        env: undefined,
        source: "stored credential",
      });
      // Overlaid built-in: the stored credential flows to the inherited auth.
      const inherited = recordingApiKeyAuth();
      const composed = composeConfiguredAuth(
        "gw",
        { id: "gw", name: "gw", auth: { apiKey: inherited }, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
        config({ apiKey: "sk-configured" }).providers.gw,
        adapters(),
      );
      const viaInherited = await composed.apiKey!.resolve({
        ctx: envCtx({}),
        credential: { type: "api_key", key: "sk-stored", env: { EXTRA: "e" } },
        signal: new AbortController().signal,
      });
      expect(viaInherited).toEqual({ auth: { apiKey: "sk-base" }, source: "base" });
      expect(inherited.calls[0]!.input.credential).toEqual({
        type: "api_key",
        key: "sk-stored",
        env: { EXTRA: "e" },
      });
    });

    it("falls back to the inherited (built-in/environment) auth when no key is configured", async () => {
      const inherited = recordingApiKeyAuth();
      const composed = composeConfiguredAuth(
        "gw",
        { id: "gw", name: "gw", auth: { apiKey: inherited }, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
        undefined,
        adapters(),
      );
      const result = await composed.apiKey!.resolve({ ctx: envCtx({}), signal: new AbortController().signal });
      expect(result).toEqual({ auth: { apiKey: "sk-base" }, source: "base" });
    });
  });

  describe("composeConfiguredAuth — headers and authHeader", () => {
    it("resolves provider headers per request and merges them into the auth result", async () => {
      const env: Record<string, string> = { HDR: "hv1" };
      const composed = composeConfiguredAuth(
        "gw",
        undefined,
        config({ apiKey: "sk-literal", headers: { "X-Static": "sv", "X-Dynamic": "$HDR" } }).providers.gw,
        adapters(env),
      );
      const resolve = (): Promise<AuthResult | undefined> =>
        composed.apiKey!.resolve({ ctx: envCtx(env), signal: new AbortController().signal });
      expect(await resolve()).toEqual({
        auth: { apiKey: "sk-literal", headers: { "X-Static": "sv", "X-Dynamic": "hv1" } },
        source: "configured API key",
      });
      env.HDR = "hv2";
      expect(await resolve()).toMatchObject({
        auth: { headers: { "X-Static": "sv", "X-Dynamic": "hv2" } },
      });
    });

    it("authHeader adds Authorization: Bearer with the resolved key", async () => {
      const composed = composeConfiguredAuth(
        "gw",
        undefined,
        config({ apiKey: "sk-literal", authHeader: true }).providers.gw,
        adapters(),
      );
      const result = await composed.apiKey!.resolve({ ctx: envCtx({}), signal: new AbortController().signal });
      expect(result).toMatchObject({
        auth: { apiKey: "sk-literal", headers: { Authorization: "Bearer sk-literal" } },
      });
    });

    it("matches the pinned failure when authHeader is set but no API key resolves", async () => {
      const headersOnly: ApiKeyAuth = {
        name: "token auth",
        resolve: async () => ({ auth: { headers: { Authorization: "Bearer tok" } }, source: "env token" }),
      };
      const composed = composeConfiguredAuth(
        "gw",
        { id: "gw", name: "gw", auth: { apiKey: headersOnly }, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
        config({ authHeader: true }).providers.gw,
        adapters(),
      );
      await expect(
        composed.apiKey!.resolve({ ctx: envCtx({}), signal: new AbortController().signal }),
      ).rejects.toThrow("authHeader requires a resolved API key");
    });

    it("keeps a preexisting Authorization header when authHeader is absent", async () => {
      const headersOnly: ApiKeyAuth = {
        name: "token auth",
        resolve: async () => ({ auth: { headers: { Authorization: "Bearer tok" } }, source: "env token" }),
      };
      const composed = composeConfiguredAuth(
        "gw",
        { id: "gw", name: "gw", auth: { apiKey: headersOnly }, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
        config({ headers: { "X-Other": "v" } }).providers.gw,
        adapters(),
      );
      const result = await composed.apiKey!.resolve({ ctx: envCtx({}), signal: new AbortController().signal });
      expect(result).toMatchObject({
        auth: { headers: { Authorization: "Bearer tok", "X-Other": "v" } },
      });
    });
  });

  describe("composeConfiguredAuth — check", () => {
    it("reports stored, configured (env/command) and inherited sources without resolving", async () => {
      const inherited = recordingApiKeyAuth();
      const composed = composeConfiguredAuth(
        "gw",
        { id: "gw", name: "gw", auth: { apiKey: inherited }, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
        config({ apiKey: "$GW_KEY" }).providers.gw,
        adapters({ GW_KEY: "k" }),
      );
      const ctx = envCtx({ GW_KEY: "k" });
      const check = (credential?: { key?: string }): Promise<{ type: string; source?: string } | undefined> =>
        composed.apiKey!.check!({ ctx, credential: credential as never, signal: new AbortController().signal });
      await expect(check({ key: "sk" })).resolves.toEqual({ type: "api_key", source: "stored credential" });
      await expect(check()).resolves.toEqual({ type: "api_key", source: "configured API key" });
      // Pinned: an empty stored key is not a key; the check falls through to
      // the inherited auth resolution.
      await expect(check({ key: "" })).resolves.toEqual({ type: "api_key", source: "base" });
      // Missing env: not configured.
      const missingCtx = envCtx({});
      await expect(
        composed.apiKey!.check!({ ctx: missingCtx, signal: new AbortController().signal }),
      ).resolves.toBeUndefined();
    });

    it("treats command-configured keys as configured without running them", async () => {
      const composed = composeConfiguredAuth(
        "gw",
        undefined,
        config({ apiKey: "!fetch-key" }).providers.gw,
        adapters(),
      );
      await expect(
        composed.apiKey!.check!({ ctx: envCtx({}), signal: new AbortController().signal }),
      ).resolves.toEqual({ type: "api_key", source: "configured API key" });
    });

    it("creates no fabricated api-key login for OAuth-only bases (pinned)", () => {
      const oauthOnly = composeConfiguredAuth(
        "gw",
        { id: "gw", name: "gw", auth: { oauth: { name: "o", login: async () => { throw new Error("no"); }, refresh: async () => { throw new Error("no"); }, toAuth: async () => ({ apiKey: "x" }) } }, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
        undefined,
        adapters(),
      );
      expect(oauthOnly.apiKey).toBeUndefined();
      expect(oauthOnly.oauth).toBeDefined();
    });
  });

  describe("composeConfiguredAuth — oauth", () => {
    it("composes configured headers and authHeader into the oauth toAuth generically", async () => {
      const received: unknown[] = [];
      const oauth: OAuthAuth = {
        name: "gw oauth",
        login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1e15 }),
        refresh: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 1e15 }),
        toAuth: async (credential) => {
          received.push(credential);
          return { apiKey: "ak-from-oauth" };
        },
      };
      const composed = composeConfiguredAuth(
        "gw",
        { id: "gw", name: "gw", auth: { oauth }, getModels: () => [], stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } },
        config({ headers: { "X-OAuth": "v" }, authHeader: true }).providers.gw,
        adapters(),
      );
      const credential = { type: "oauth" as const, access: "a", refresh: "r", expires: 1e15 };
      const auth = await composed.oauth!.toAuth(credential);
      expect(auth).toEqual({
        apiKey: "ak-from-oauth",
        headers: { "X-OAuth": "v", Authorization: "Bearer ak-from-oauth" },
      });
      expect(received).toEqual([credential]);
    });
  });

  describe("resolveConfiguredModelHeaders", () => {
    it("merges modelOverrides then model definition headers (definition wins) per request", async () => {
      const adapt = adapters({ MH: "mh1" });
      const headers1 = resolveConfiguredModelHeaders(
        model("m1"),
        config({
          models: [{ id: "m1", headers: { "X-Model": "$MH", "X-Both": "definition" } }],
          modelOverrides: { m1: { headers: { "X-Override": "ov", "X-Both": "override" } } },
        }).providers.gw,
        adapt,
      );
      expect(headers1).toEqual({ "X-Model": "mh1", "X-Both": "definition", "X-Override": "ov" });
    });

    it("returns undefined when no model-level headers are configured", () => {
      expect(
        resolveConfiguredModelHeaders(
          model("m1"),
          config({ apiKey: "sk" }).providers.gw,
          adapters(),
        ),
      ).toBeUndefined();
    });
  });

  describe("request composition Models facade", () => {
    function composedModels(
      providerConfig: ModelsJsonProviderConfig | undefined,
      opts: {
        env?: Readonly<Record<string, string>>;
        commands?: Readonly<Record<string, string>>;
        models?: readonly Model<Api>[];
        /** Override the composed auth (e.g. a custom baseUrl override). */
        auth?: ProviderAuth;
      } = {},
    ): {
      models: Models;
      recordings: Array<{ model: Model<Api>; options?: SimpleStreamOptions }>;
    } {
      const recordings: Array<{ model: Model<Api>; options?: SimpleStreamOptions }> = [];
      const adapt = adapters(opts.env ?? {}, opts.commands ?? {});
      const providerConfigRecord =
        providerConfig === undefined ? undefined : config(providerConfig);
      // The catalog registers the composed auth (models.json facts composed
      // into the Provider contract); the facade adds only the per-request
      // model-level header layer.
      const auth =
        opts.auth ??
        composeConfiguredAuth(
          "gw",
          undefined,
          providerConfigRecord?.providers.gw,
          adapt,
        );
      const underlying = createModels({ credentials: new InMemoryCredentialStore() });
      underlying.setProvider(
        providerWith("gw", auth, opts.models ?? [model("m1")], recordings),
      );
      return {
        models: createRequestCompositionModels(underlying, providerConfigRecord, adapt),
        recordings,
      };
    }

    it("merges auth, built-in model and configured model headers case-insensitively", async () => {
      const { models } = composedModels(
        {
          apiKey: "sk-literal",
          headers: { "X-Provider": "pv" },
          models: [{ id: "m1", headers: { "X-Model-Config": "mv" } }],
          modelOverrides: { m1: { headers: { "X-API-KEY": "override-key" } } },
        },
        { models: [model("m1", { "X-Builtin": "bv", "x-api-key": "builtin-key" })] },
      );
      const resolution = await models.getAuth(models.getModel("gw", "m1")!);
      // Case-insensitive merge: the modelOverride "X-API-KEY" replaces the
      // built-in model's lowercase "x-api-key"; auth-level and model-level
      // headers all survive.
      expect(resolution?.auth.headers).toEqual({
        "X-Provider": "pv",
        "X-Builtin": "bv",
        "X-Model-Config": "mv",
        "X-API-KEY": "override-key",
      });
      expect(resolution?.auth.apiKey).toBe("sk-literal");
    });

    it("resolves model-level headers per request from the resolution env", async () => {
      const env: Record<string, string> = { MH: "one" };
      const { models } = composedModels(
        { apiKey: "sk", models: [{ id: "m1", headers: { "X-M": "$MH" } }] },
        { env },
      );
      const m = models.getModel("gw", "m1")!;
      expect((await models.getAuth(m))?.auth.headers).toEqual({ "X-M": "one" });
      env.MH = "two";
      expect((await models.getAuth(m))?.auth.headers).toEqual({ "X-M": "two" });
    });

    it("delegates the provider-id overload without model headers", async () => {
      const { models } = composedModels(
        { apiKey: "sk", headers: { "X-Provider": "pv" } },
        { models: [model("m1", { "X-Builtin": "bv" })] },
      );
      const resolution = await models.getAuth("gw");
      expect(resolution?.auth.headers).toEqual({ "X-Provider": "pv" });
      expect(resolution?.auth.apiKey).toBe("sk");
    });

    it("delivers the composed apiKey and headers to the provider stream", async () => {
      const { models, recordings } = composedModels(
        {
          apiKey: "sk-literal",
          authHeader: true,
          models: [{ id: "m1", headers: { "X-Model-Config": "mv" } }],
        },
        { models: [model("m1", { "X-Builtin": "bv" })] },
      );
      const result = await models.streamSimple(models.getModel("gw", "m1")!, {
        sessionId: "s",
      } as never).result();
      expect(result.stopReason).toBe("stop");
      const recorded = recordings[0]!;
      expect(recorded.options?.apiKey).toBe("sk-literal");
      expect(recorded.options?.headers).toEqual({
        "X-Builtin": "bv",
        "X-Model-Config": "mv",
        Authorization: "Bearer sk-literal",
      });
      expect(recorded.model.baseUrl).toBe("https://gw.example.com");
    });

    it("applies an auth baseUrl override to the request model", async () => {
      const authWithBaseUrl: ApiKeyAuth = {
        name: "base auth",
        resolve: async () => ({
          auth: { apiKey: "sk", baseUrl: "https://override.example.com" },
          source: "base",
        }),
      };
      const { models, recordings } = composedModels(
        { apiKey: "sk" },
        { auth: { apiKey: authWithBaseUrl } },
      );
      await models.streamSimple(models.getModel("gw", "m1")!, {} as never).result();
      expect(recordings[0]?.model.baseUrl).toBe("https://override.example.com");
    });

    it("lets request-option headers win over composed headers", async () => {
      const { models, recordings } = composedModels(
        { apiKey: "sk", headers: { "X-Win": "composed" } },
      );
      await models
        .streamSimple(models.getModel("gw", "m1")!, {} as never, {
          headers: { "x-win": "request" },
        } as never)
        .result();
      expect(recordings[0]?.options?.headers).toEqual({ "x-win": "request" });
    });

    it("terminates with an unconfigured-provider error when auth cannot resolve", async () => {
      const unconfigured: ApiKeyAuth = {
        name: "never",
        resolve: async () => undefined,
      };
      const { models } = composedModels(undefined, { auth: { apiKey: unconfigured } });
      const message = await models.streamSimple(models.getModel("gw", "m1")!, {} as never).result();
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toContain("Provider is not configured: gw");
    });

    it("propagates bounded secret-free failures when resolution fails", async () => {
      const { models } = composedModels({ apiKey: "$CANARY_ENV_NAME_42" });
      const message = await models.streamSimple(models.getModel("gw", "m1")!, {} as never).result();
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).not.toContain("CANARY_ENV_NAME_42");
      expect(message.errorMessage).toContain('API key for provider "gw"');
    });
  });

  describe("resolveRequestModel", () => {
    const base = model("m1", undefined);

    it("materializes {NAME} tokens from the resolved auth env with the pinned literal fallback", () => {
      const cloudflare = {
        ...base,
        baseUrl:
          "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
      };
      const resolved = resolveRequestModel(cloudflare, {
        auth: { apiKey: "sk" },
        env: { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_GATEWAY_ID: "gw" },
        source: "x",
      });
      expect(resolved.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct/gw/openai",
      );
      // The catalog model is never mutated and carries no env values.
      expect(cloudflare.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai",
      );
    });

    it("keeps tokens literal when the env does not resolve them", () => {
      const withToken = { ...base, baseUrl: "https://host/{UNRESOLVED}/x" };
      expect(resolveRequestModel(withToken, { auth: {}, env: {}, source: "x" }).baseUrl).toBe(
        "https://host/{UNRESOLVED}/x",
      );
      expect(resolveRequestModel(withToken, undefined).baseUrl).toBe(
        "https://host/{UNRESOLVED}/x",
      );
    });

    it("lets an auth baseUrl override win over materialization", () => {
      const withToken = { ...base, baseUrl: "https://host/{ACCOUNT}/x" };
      const resolved = resolveRequestModel(withToken, {
        auth: { apiKey: "sk", baseUrl: "https://override.example.com" },
        env: { ACCOUNT: "acct" },
        source: "x",
      });
      expect(resolved.baseUrl).toBe("https://override.example.com");
    });
  });

  describe("ModelsError surface", () => {
    it("wraps resolution failures with the ModelsError auth code", async () => {
      const failing: ApiKeyAuth = {
        name: "failing",
        resolve: async () => {
          throw new Error("bounded message");
        },
      };
      const underlying = createModels({ credentials: new InMemoryCredentialStore() });
      underlying.setProvider(providerWith("gw", { apiKey: failing }, [model("m1")], []));
      const wrapped = createRequestCompositionModels(underlying, undefined, adapters());
      const message = await wrapped.streamSimple(wrapped.getModel("gw", "m1")!, {} as never).result();
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toContain("bounded message");
      expect(() => {
        throw new ModelsError("auth", "x");
      }).toThrow("x");
    });
  });
});
