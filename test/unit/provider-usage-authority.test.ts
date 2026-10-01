import type { AuthResult, Models, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import type {
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import {
  createProviderUsageAuthority,
} from "../../src/provider-usage/authority.js";
import type {
  ProviderUsageProbe,
  ProviderUsageProbeInput,
} from "../../src/provider-usage/contract.js";
import { createCommandCodeGoatUsageProbe } from "../../src/provider-usage/probes/commandcode-goat.js";

function managed(
  credentialId: string,
  credentialGeneration: string,
  selectionGeneration: string,
  authType: "api_key" | "oauth" = "api_key",
  providerId = "fixture",
): ProviderAuthBindingCapture {
  return Object.freeze({
    facts: Object.freeze({
      kind: "managed" as const,
      providerId,
      credentialId,
      authType,
      authMethodLabel: authType === "oauth" ? "OAuth" : "API key",
      displayName: credentialId,
      credentialGeneration,
      selectionGeneration,
    }),
  });
}

function sameCapture(
  a: ProviderAuthBindingCapture,
  b: ProviderAuthBindingCapture,
): boolean {
  if (a.facts.kind !== b.facts.kind || a.facts.providerId !== b.facts.providerId) {
    return false;
  }
  if (a.facts.kind === "ambient" || b.facts.kind === "ambient") {
    return a.facts.kind === b.facts.kind;
  }
  if (a.facts.kind === "external" && b.facts.kind === "external") {
    return (
      a.facts.canonicalPath === b.facts.canonicalPath &&
      a.facts.identityKey === b.facts.identityKey &&
      a.facts.tokenRevision === b.facts.tokenRevision &&
      a.facts.authType === b.facts.authType
    );
  }
  if (a.facts.kind !== "managed" || b.facts.kind !== "managed") return false;
  return (
    a.facts.credentialId === b.facts.credentialId &&
    a.facts.credentialGeneration === b.facts.credentialGeneration &&
    a.facts.selectionGeneration === b.facts.selectionGeneration &&
    a.facts.authType === b.facts.authType
  );
}

function createBinding(initial: ProviderAuthBindingCapture) {
  let current = initial;
  let beforePublish: (() => void) | undefined;
  const binding = {
    capture: async () => current,
    publishIfCurrent: async (
      capture: ProviderAuthBindingCapture,
      publish: Parameters<ProviderAuthBindingAuthority["publishIfCurrent"]>[1],
    ) => {
      beforePublish?.();
      beforePublish = undefined;
      if (!sameCapture(capture, current)) return false;
      const assertCurrent = () => {
        if (!sameCapture(capture, current)) throw new Error("stale");
      };
      await publish(assertCurrent, capture.facts);
      return sameCapture(capture, current);
    },
    runBound: async <T>(
      capture: ProviderAuthBindingCapture,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (!sameCapture(capture, current)) throw new Error("stale binding");
      return operation();
    },
  } as unknown as ProviderAuthBindingAuthority;
  return {
    binding,
    setCurrent(next: ProviderAuthBindingCapture) {
      current = next;
    },
    beforeNextPublish(callback: () => void) {
      beforePublish = callback;
    },
  };
}

function createModels(options: {
  readonly baseUrl?: string;
  readonly providerBaseUrl?: string;
  readonly modelBaseUrls?: readonly string[];
  readonly auth?: AuthResult;
  readonly onGetAuth?: (signal: AbortSignal | undefined) => void;
}) {
  let authCalls = 0;
  let providerBaseUrl = options.providerBaseUrl ?? options.baseUrl;
  let modelBaseUrls =
    options.modelBaseUrls ??
    (options.baseUrl === undefined ? [] : [options.baseUrl]);
  const models = {
    getProviders: () => [
      {
        id: "fixture",
        name: "Fixture",
        ...(providerBaseUrl === undefined ? {} : { baseUrl: providerBaseUrl }),
      } as unknown as Provider,
    ],
    getProvider: (id: string) =>
      id === "fixture"
        ? ({
            id: "fixture",
            name: "Fixture",
            ...(providerBaseUrl === undefined ? {} : { baseUrl: providerBaseUrl }),
          } as unknown as Provider)
        : undefined,
    getModels: () =>
      modelBaseUrls.map((baseUrl) => ({ provider: "fixture", baseUrl })),
    getAuth: async (_providerId: string, overrides?: { readonly signal?: AbortSignal }) => {
      authCalls += 1;
      options.onGetAuth?.(overrides?.signal);
      return options.auth;
    },
  } as unknown as Pick<
    Models,
    "getProviders" | "getProvider" | "getModels" | "getAuth"
  >;
  return {
    models,
    authCalls: () => authCalls,
    setBaseUrl(next: string | undefined) {
      providerBaseUrl = next;
      modelBaseUrls = next === undefined ? [] : [next];
    },
    setModelBaseUrls(next: readonly string[]) {
      modelBaseUrls = next;
    },
  };
}

function observedProbe(options: {
  readonly eligibility?: ProviderUsageProbe["eligibility"];
  readonly acquire?: (input: ProviderUsageProbeInput) => ReturnType<ProviderUsageProbe["acquire"]>;
} = {}): ProviderUsageProbe {
  return Object.freeze({
    providerId: "fixture",
    eligibility:
      options.eligibility ??
      (() => Object.freeze({ state: "eligible" as const })),
    acquire:
      options.acquire ??
      (async () =>
        Object.freeze({
          state: "observed" as const,
          facts: Object.freeze({
            windows: Object.freeze([
              Object.freeze({ kind: "weekly" as const, usedPercent: 42 }),
            ]),
            budgets: Object.freeze([]),
          }),
        })),
  });
}

describe("ProviderUsageAuthority", () => {
  it("refreshes Goat when its served models use both canonical API paths", async () => {
    const providerId = "commandcode-goat";
    const root = "https://api.commandcode.ai/provider";
    const bindings = createBinding(managed("goat", "g1", "s1", "api_key", providerId));
    let authCalls = 0;
    let modelBaseUrls = [root, `${root}/v1`];
    const models = {
      getProviders: () => [{ id: providerId, name: "CommandCode Goat", baseUrl: root }],
      getProvider: (id: string) =>
        id === providerId ? { id: providerId, name: "CommandCode Goat", baseUrl: root } : undefined,
      getModels: () => modelBaseUrls.map((baseUrl) => ({ provider: providerId, baseUrl })),
      getAuth: async () => {
        authCalls += 1;
        return { auth: { apiKey: "fixture-secret" }, source: "fixture" };
      },
    } as unknown as Pick<Models, "getProviders" | "getProvider" | "getModels" | "getAuth">;
    const fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.endsWith("/alpha/whoami")
            ? {}
            : {
                windowLimits: {
                  fiveHour: { cap: 10, used: 5 },
                },
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const authority = createProviderUsageAuthority({
      models,
      binding: bindings.binding,
      probes: [createCommandCodeGoatUsageProbe(fetch)],
    });

    const result = await authority.refresh(providerId);

    expect(result.refresh).toEqual({ providerId, outcome: "succeeded" });
    expect(authCalls).toBe(1);
    expect(result.snapshot.providers).toMatchObject([
      { state: "observed", observation: { windows: [{ usedPercent: 50 }] } },
    ]);

    modelBaseUrls = [root, "https://proxy.example/v1"];
    expect((await authority.query()).providers[0]).toEqual({
      state: "unsupported",
      providerId,
      reason: "destination",
    });
    expect((await authority.refresh(providerId)).refresh).toEqual({
      providerId,
      outcome: "unsupported",
      reason: "destination",
    });
    expect(authCalls).toBe(1);
  });

  it("does not resolve auth when the current binding is unsupported", async () => {
    const current = managed("a", "g1", "s1", "oauth");
    const bindings = createBinding(current);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let acquireCalls = 0;
    const probe = observedProbe({
      eligibility: (context) => {
        expect(context.binding).toEqual({ kind: "managed", authType: "oauth" });
        return { state: "unsupported_binding" };
      },
      acquire: async () => {
        acquireCalls += 1;
        return { state: "unavailable", reason: "upstream" };
      },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
    });

    const result = await authority.refresh("fixture");

    expect(result.refresh).toEqual({
      providerId: "fixture",
      outcome: "unsupported",
      reason: "binding",
    });
    expect(models.authCalls()).toBe(0);
    expect(acquireCalls).toBe(0);
  });

  it("passes the effective Provider destination to eligibility before auth", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      baseUrl: "https://proxy.example/v1",
      auth: { auth: { apiKey: "secret" } },
    });
    const seen: string[] = [];
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          eligibility: (context) => {
            seen.push(context.effectiveBaseUrl ?? "");
            return { state: "unsupported_destination" };
          },
        }),
      ],
    });

    const result = await authority.refresh("fixture");

    expect(seen).toEqual(["https://proxy.example/v1", "https://proxy.example/v1"]);
    expect(result.refresh).toEqual({
      providerId: "fixture",
      outcome: "unsupported",
      reason: "destination",
    });
    expect(models.authCalls()).toBe(0);
  });

  it("re-checks credential-scoped baseUrl after auth before quota network", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: {
        auth: {
          apiKey: "secret",
          baseUrl: "https://credential-proxy.example/v1",
        },
      },
    });
    let acquireCalls = 0;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          eligibility: (context) =>
            context.effectiveBaseUrl === "https://fixture.invalid"
              ? { state: "eligible" }
              : { state: "unsupported_destination" },
          acquire: async () => {
            acquireCalls += 1;
            return { state: "observed", facts: { windows: [], budgets: [] } };
          },
        }),
      ],
    });

    const result = await authority.refresh("fixture");

    expect(result.refresh).toEqual({
      providerId: "fixture",
      outcome: "unsupported",
      reason: "destination",
    });
    expect(models.authCalls()).toBe(1);
    expect(acquireCalls).toBe(0);
  });

  it("uses one Authority signal for auth resolution and probe acquisition", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    let authSignal: AbortSignal | undefined;
    let probeSignal: AbortSignal | undefined;
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
      onGetAuth: (signal) => {
        authSignal = signal;
      },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async (input) => {
            probeSignal = input.signal;
            return {
              state: "observed",
              facts: { windows: [], budgets: [] },
            };
          },
        }),
      ],
      now: () => 123,
      refreshTimeoutMs: 10_000,
    });

    const result = await authority.refresh("fixture");

    expect(result.refresh.outcome).toBe("succeeded");
    expect(authSignal).toBeDefined();
    expect(probeSignal).toBe(authSignal);
  });

  it("commits authoritative empty success and clears prior facts", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let empty = false;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () => ({
            state: "observed",
            facts: empty
              ? { windows: [], budgets: [] }
              : {
                  windows: [{ kind: "weekly", usedPercent: 75 }],
                  budgets: [],
                },
          }),
        }),
      ],
      now: () => (empty ? 2 : 1),
    });

    await authority.refresh("fixture");
    expect((await authority.query()).providers[0]).toMatchObject({
      state: "observed",
      observation: { windows: [{ kind: "weekly", usedPercent: 75 }] },
    });

    empty = true;
    await authority.refresh("fixture");
    expect((await authority.query()).providers[0]).toEqual({
      state: "observed",
      refreshable: true,
      observation: {
        providerId: "fixture",
        observedAt: 2,
        windows: [],
        budgets: [],
      },
    });
  });

  it("never returns a previous Profile slot for a newly active Profile", async () => {
    const a = managed("a", "g1", "s1");
    const b = managed("b", "g2", "s2");
    const bindings = createBinding(a);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [observedProbe()],
      now: () => 1,
    });

    await authority.refresh("fixture");
    bindings.setCurrent(b);

    expect((await authority.query()).providers[0]).toEqual({
      state: "unobserved",
      providerId: "fixture",
    });
  });

  it("guards query against a binding switch after cache lookup", async () => {
    const a = managed("a", "g1", "s1");
    const b = managed("b", "g2", "s2");
    const bindings = createBinding(a);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [observedProbe()],
      now: () => 1,
    });
    await authority.refresh("fixture");

    bindings.beforeNextPublish(() => bindings.setCurrent(b));
    expect((await authority.query()).providers[0]).toEqual({
      state: "unobserved",
      providerId: "fixture",
    });
  });

  it("discards a refresh that finishes after the binding changes", async () => {
    const a = managed("a", "g1", "s1");
    const b = managed("b", "g2", "s2");
    const bindings = createBinding(a);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () => {
            await gate;
            return {
              state: "observed",
              facts: { windows: [{ kind: "weekly", usedPercent: 12 }], budgets: [] },
            };
          },
        }),
      ],
      now: () => 1,
    });

    const pending = authority.refresh("fixture");
    await Promise.resolve();
    bindings.setCurrent(b);
    release();

    const result = await pending;
    expect(result.refresh).toEqual({
      providerId: "fixture",
      outcome: "superseded",
    });
    expect((await authority.query()).providers[0]).toEqual({
      state: "unobserved",
      providerId: "fixture",
    });
  });

  it("publishes passive facts only while the captured binding is current", async () => {
    const a = managed("a", "g1", "s1");
    const b = managed("b", "g2", "s2");
    const bindings = createBinding(a);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [observedProbe()],
      now: () => 9,
    });
    const facts = {
      windows: [{ kind: "five_hour" as const, usedPercent: 50 }],
      budgets: [],
    };

    expect(
      await authority.observePassive(
        "fixture",
        a,
        "https://fixture.invalid",
        facts,
      ),
    ).toBe(true);
    expect((await authority.query()).providers[0]).toMatchObject({
      state: "observed",
      observation: {
        observedAt: 9,
        windows: [{ kind: "five_hour", usedPercent: 50 }],
      },
    });

    bindings.setCurrent(b);
    expect(
      await authority.observePassive(
        "fixture",
        a,
        "https://fixture.invalid",
        facts,
      ),
    ).toBe(false);
    expect((await authority.query()).providers[0]).toEqual({
      state: "unobserved",
      providerId: "fixture",
    });
  });

  it("shows a current passive observation even when the binding is not actively refreshable", async () => {
    const capture = managed("a", "g1", "s1", "api_key");
    const bindings = createBinding(capture);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          eligibility: () => ({ state: "unsupported_binding" }),
        }),
      ],
      now: () => 10,
    });

    expect(
      await authority.observePassive(
        "fixture",
        capture,
        "https://fixture.invalid",
        {
          windows: [{ kind: "weekly", usedPercent: 22 }],
          budgets: [],
        },
      ),
    ).toBe(true);

    expect((await authority.query()).providers[0]).toEqual({
      state: "observed",
      refreshable: false,
      observation: {
        providerId: "fixture",
        observedAt: 10,
        windows: [{ kind: "weekly", usedPercent: 22 }],
        budgets: [],
      },
    });
    expect(models.authCalls()).toBe(0);
  });

  it("replaces passive observations instead of carrying forward stale facts", async () => {
    const capture = managed("a", "g1", "s1", "api_key");
    const bindings = createBinding(capture);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let tick = 0;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          eligibility: () => ({ state: "unsupported_binding" }),
        }),
      ],
      now: () => ++tick,
    });

    await authority.observePassive(
      "fixture",
      capture,
      "https://fixture.invalid",
      {
        windows: [{ kind: "weekly", usedPercent: 20 }],
        budgets: [],
      },
    );
    await authority.observePassive(
      "fixture",
      capture,
      "https://fixture.invalid",
      {
        windows: [{ kind: "five_hour", usedPercent: 50 }],
        budgets: [],
      },
    );

    expect((await authority.query()).providers[0]).toEqual({
      state: "observed",
      refreshable: false,
      observation: {
        providerId: "fixture",
        observedAt: 2,
        windows: [{ kind: "five_hour", usedPercent: 50 }],
        budgets: [],
      },
    });
  });

  it("uses served model destinations ahead of Provider baseUrl", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      providerBaseUrl: "https://fixture.invalid",
      modelBaseUrls: ["https://proxy.example/v1"],
      auth: { auth: { apiKey: "secret" } },
    });
    const seen: Array<string | undefined> = [];
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          eligibility: (context) => {
            seen.push(context.effectiveBaseUrl);
            return context.effectiveBaseUrl === "https://fixture.invalid"
              ? { state: "eligible" }
              : { state: "unsupported_destination" };
          },
        }),
      ],
    });

    const result = await authority.refresh("fixture");

    expect(seen).toEqual(["https://proxy.example/v1", "https://proxy.example/v1"]);
    expect(result.refresh).toEqual({
      providerId: "fixture",
      outcome: "unsupported",
      reason: "destination",
    });
    expect(models.authCalls()).toBe(0);
  });

  it("rejects a served model destination outside the probe's accepted paths before auth", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      providerBaseUrl: "https://fixture.invalid",
      modelBaseUrls: [
        "https://fixture.invalid",
        "https://proxy.example/v1",
      ],
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          eligibility: (context) =>
            context.effectiveBaseUrl === "https://fixture.invalid"
              ? { state: "eligible" }
              : { state: "unsupported_destination" },
        }),
      ],
    });

    const result = await authority.refresh("fixture");

    expect(result.refresh).toEqual({
      providerId: "fixture",
      outcome: "unsupported",
      reason: "destination",
    });
    expect(models.authCalls()).toBe(0);
  });

  it("does not reuse a cached observation after the effective Provider destination changes", async () => {
    const capture = managed("a", "g1", "s1", "api_key");
    const bindings = createBinding(capture);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          eligibility: (context) =>
            context.effectiveBaseUrl === "https://fixture.invalid"
              ? { state: "eligible" }
              : { state: "unsupported_destination" },
        }),
      ],
      now: () => 10,
    });

    await authority.refresh("fixture");
    expect((await authority.query()).providers[0]).toMatchObject({
      state: "observed",
      refreshable: true,
    });

    models.setBaseUrl("https://proxy.example/v1");

    expect((await authority.query()).providers[0]).toEqual({
      state: "unsupported",
      providerId: "fixture",
      reason: "destination",
    });
  });

  it("drops a query candidate when the effective destination changes during publication", async () => {
    const capture = managed("a", "g1", "s1");
    const bindings = createBinding(capture);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [observedProbe()],
      now: () => 1,
    });

    await authority.refresh("fixture");
    bindings.beforeNextPublish(() => {
      models.setBaseUrl("https://proxy.example/v1");
    });

    expect((await authority.query()).providers[0]).toEqual({
      state: "unobserved",
      providerId: "fixture",
    });
  });

  it("does not de-duplicate in-flight refreshes across destination changes", async () => {
    const capture = managed("a", "g1", "s1");
    const bindings = createBinding(capture);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const releases: Array<() => void> = [];
    let acquireCalls = 0;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () => {
            acquireCalls += 1;
            await new Promise<void>((resolve) => releases.push(resolve));
            return {
              state: "observed",
              facts: { windows: [], budgets: [] },
            };
          },
        }),
      ],
    });

    const first = authority.refresh("fixture");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    models.setBaseUrl("https://proxy.example/v1");
    const second = authority.refresh("fixture");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(acquireCalls).toBe(2);
    for (const release of releases) release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.refresh.outcome).toBe("superseded");
    expect(secondResult.refresh.outcome).toBe("succeeded");
  });

  it("rejects passive observations from a destination different from the current served destination", async () => {
    const capture = managed("a", "g1", "s1", "api_key");
    const bindings = createBinding(capture);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [observedProbe()],
    });

    expect(
      await authority.observePassive(
        "fixture",
        capture,
        "https://proxy.example/v1",
        {
          windows: [{ kind: "weekly", usedPercent: 10 }],
          budgets: [],
        },
      ),
    ).toBe(false);
    expect((await authority.query()).providers[0]).toEqual({
      state: "unobserved",
      providerId: "fixture",
    });
  });

  it("rejects passive observations when served models have ambiguous destinations", async () => {
    const capture = managed("a", "g1", "s1", "api_key");
    const bindings = createBinding(capture);
    const models = createModels({
      providerBaseUrl: "https://fixture.invalid",
      modelBaseUrls: [
        "https://fixture.invalid",
        "https://proxy.example/v1",
      ],
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [observedProbe()],
    });

    expect(
      await authority.observePassive(
        "fixture",
        capture,
        "https://fixture.invalid",
        {
          windows: [{ kind: "weekly", usedPercent: 10 }],
          budgets: [],
        },
      ),
    ).toBe(false);
  });

  it("keeps cache-only query free of auth/acquisition and retries capture failure once", async () => {
    const capture = managed("a", "g1", "s1");
    let captureCalls = 0;
    let acquireCalls = 0;
    const binding = {
      capture: async () => {
        captureCalls += 1;
        if (captureCalls === 1) throw new Error("transient capture failure");
        return capture;
      },
      publishIfCurrent: async (
        _capture: ProviderAuthBindingCapture,
        publish: Parameters<ProviderAuthBindingAuthority["publishIfCurrent"]>[1],
      ) => {
        await publish(() => undefined, capture.facts);
        return true;
      },
      runBound: async <T>(
        _capture: ProviderAuthBindingCapture,
        operation: () => Promise<T>,
      ) => operation(),
    } as unknown as ProviderAuthBindingAuthority;
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding,
      probes: [
        observedProbe({
          acquire: async () => {
            acquireCalls += 1;
            return { state: "observed", facts: { windows: [], budgets: [] } };
          },
        }),
      ],
    });

    expect(await authority.query()).toEqual({
      providers: [{ state: "unobserved", providerId: "fixture" }],
    });
    expect(captureCalls).toBe(2);
    expect(models.authCalls()).toBe(0);
    expect(acquireCalls).toBe(0);
  });

  it("returns unobserved when query capture remains unstable", async () => {
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let captureCalls = 0;
    const binding = {
      capture: async () => {
        captureCalls += 1;
        throw new Error("capture unavailable");
      },
    } as unknown as ProviderAuthBindingAuthority;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding,
      probes: [observedProbe()],
    });

    expect(await authority.query()).toEqual({
      providers: [{ state: "unobserved", providerId: "fixture" }],
    });
    expect(captureCalls).toBe(2);
    expect(models.authCalls()).toBe(0);
  });

  it("keeps last-good observation when an explicit refresh fails", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let fail = false;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () =>
            fail
              ? { state: "unavailable", reason: "network" }
              : {
                  state: "observed",
                  facts: {
                    windows: [{ kind: "weekly", usedPercent: 41 }],
                    budgets: [],
                  },
                },
        }),
      ],
      now: () => 7,
    });

    await authority.refresh("fixture");
    fail = true;
    const failed = await authority.refresh("fixture");

    expect(failed.refresh).toEqual({
      providerId: "fixture",
      outcome: "unavailable",
      reason: "network",
    });
    expect(failed.snapshot.providers[0]).toMatchObject({
      state: "observed",
      observation: {
        observedAt: 7,
        windows: [{ kind: "weekly", usedPercent: 41 }],
      },
    });
  });

  it("does not share in-flight work across credential generations", async () => {
    const g1 = managed("a", "g1", "s1");
    const g2 = managed("a", "g2", "s2");
    const bindings = createBinding(g1);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let calls = 0;
    const releases: Array<() => void> = [];
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () => {
            calls += 1;
            await new Promise<void>((resolve) => releases.push(resolve));
            return { state: "observed", facts: { windows: [], budgets: [] } };
          },
        }),
      ],
    });

    const first = authority.refresh("fixture");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    bindings.setCurrent(g2);
    const second = authority.refresh("fixture");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(2);
    for (const release of releases) release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.refresh.outcome).toBe("superseded");
    expect(secondResult.refresh.outcome).toBe("succeeded");
  });

  it("retains only one current cache slot per Provider", async () => {
    const a = managed("a", "g1", "s1");
    const b = managed("b", "g2", "s2");
    const bindings = createBinding(a);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let usedPercent = 10;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () => ({
            state: "observed",
            facts: {
              windows: [{ kind: "weekly", usedPercent }],
              budgets: [],
            },
          }),
        }),
      ],
    });

    await authority.refresh("fixture");
    bindings.setCurrent(b);
    usedPercent = 20;
    await authority.refresh("fixture");
    bindings.setCurrent(a);

    expect((await authority.query()).providers[0]).toEqual({
      state: "unobserved",
      providerId: "fixture",
    });
  });

  it("contains a throwing eligibility probe so other Providers still query", async () => {
    const captures = new Map([
      ["broken", managed("broken", "g1", "s1", "api_key", "broken")],
      ["healthy", managed("healthy", "g1", "s1", "api_key", "healthy")],
    ]);
    const binding = {
      capture: async (providerId: string) => captures.get(providerId)!,
      publishIfCurrent: async (
        _capture: ProviderAuthBindingCapture,
        publish: Parameters<ProviderAuthBindingAuthority["publishIfCurrent"]>[1],
      ) => {
        await publish(() => undefined, _capture.facts);
        return true;
      },
      runBound: async <T>(
        _capture: ProviderAuthBindingCapture,
        operation: () => Promise<T>,
      ) => operation(),
    } as unknown as ProviderAuthBindingAuthority;
    const providers = ["broken", "healthy"].map(
      (id) => ({ id, name: id, baseUrl: `https://${id}.invalid` }) as unknown as Provider,
    );
    const models = {
      getProviders: () => providers,
      getProvider: (id: string) => providers.find((provider) => provider.id === id),
      getModels: (id: string) => [{ provider: id, baseUrl: `https://${id}.invalid` }],
      getAuth: async () => ({ auth: { apiKey: "secret" } }),
    } as unknown as Pick<
      Models,
      "getProviders" | "getProvider" | "getModels" | "getAuth"
    >;
    const authority = createProviderUsageAuthority({
      models,
      binding,
      probes: [
        {
          providerId: "broken",
          eligibility: () => {
            throw new Error("probe bug");
          },
          acquire: async () => ({
            state: "observed",
            facts: { windows: [], budgets: [] },
          }),
        },
        {
          providerId: "healthy",
          eligibility: () => ({ state: "eligible" }),
          acquire: async () => ({
            state: "observed",
            facts: { windows: [], budgets: [] },
          }),
        },
      ],
    });

    expect(await authority.query()).toEqual({
      providers: [
        { state: "unobserved", providerId: "broken" },
        { state: "unobserved", providerId: "healthy" },
      ],
    });
  });

  it("keeps CommandCode Goat and Private cache/binding identities isolated", async () => {
    const captures = new Map<string, ProviderAuthBindingCapture>([
      [
        "commandcode-goat",
        managed("goat-a", "g1", "s1", "api_key", "commandcode-goat"),
      ],
      [
        "commandcode-private",
        managed("private-a", "p1", "s1", "api_key", "commandcode-private"),
      ],
    ]);
    const binding = {
      capture: async (providerId: string) => captures.get(providerId)!,
      publishIfCurrent: async (
        capture: ProviderAuthBindingCapture,
        publish: Parameters<ProviderAuthBindingAuthority["publishIfCurrent"]>[1],
      ) => {
        const current = captures.get(capture.facts.providerId);
        if (current === undefined || !sameCapture(capture, current)) return false;
        await publish(() => undefined, capture.facts);
        return sameCapture(capture, captures.get(capture.facts.providerId)!);
      },
      runBound: async <T>(
        capture: ProviderAuthBindingCapture,
        operation: () => Promise<T>,
      ) => {
        const current = captures.get(capture.facts.providerId);
        if (current === undefined || !sameCapture(capture, current)) {
          throw new Error("stale");
        }
        return operation();
      },
    } as unknown as ProviderAuthBindingAuthority;
    const ids = ["commandcode-goat", "commandcode-private"] as const;
    const providers = ids.map(
      (id) => ({ id, name: id, baseUrl: `https://${id}.invalid` }) as unknown as Provider,
    );
    const models = {
      getProviders: () => providers,
      getProvider: (id: string) => providers.find((provider) => provider.id === id),
      getModels: (id: string) => [{ provider: id, baseUrl: `https://${id}.invalid` }],
      getAuth: async () => ({ auth: { apiKey: "same-wire-secret" } }),
    } as unknown as Pick<
      Models,
      "getProviders" | "getProvider" | "getModels" | "getAuth"
    >;
    const probe = (providerId: string): ProviderUsageProbe => ({
      providerId,
      eligibility: () => ({ state: "eligible" }),
      acquire: async () => ({
        state: "observed",
        facts: {
          windows: [{ kind: "weekly", usedPercent: 50 }],
          budgets: [],
        },
      }),
    });
    const authority = createProviderUsageAuthority({
      models,
      binding,
      probes: ids.map(probe),
      now: () => 1,
    });

    await authority.refresh("commandcode-goat");
    await authority.refresh("commandcode-private");
    expect(await authority.query()).toMatchObject({
      providers: [
        {
          state: "observed",
          observation: {
            providerId: "commandcode-goat",
            windows: [{ kind: "weekly", usedPercent: 50 }],
          },
        },
        {
          state: "observed",
          observation: {
            providerId: "commandcode-private",
            windows: [{ kind: "weekly", usedPercent: 50 }],
          },
        },
      ],
    });

    captures.set(
      "commandcode-goat",
      managed("goat-a", "g2", "s2", "api_key", "commandcode-goat"),
    );

    expect(await authority.query()).toMatchObject({
      providers: [
        { state: "unobserved", providerId: "commandcode-goat" },
        {
          state: "observed",
          observation: { providerId: "commandcode-private" },
        },
      ],
    });
  });

  it("does not share in-flight work across Providers", async () => {
    const captures = new Map([
      ["a", managed("a", "g1", "s1", "api_key", "a")],
      ["b", managed("b", "g1", "s1", "api_key", "b")],
    ]);
    const binding = {
      capture: async (providerId: string) => captures.get(providerId)!,
      publishIfCurrent: async (
        _capture: ProviderAuthBindingCapture,
        publish: Parameters<ProviderAuthBindingAuthority["publishIfCurrent"]>[1],
      ) => {
        await publish(() => undefined, _capture.facts);
        return true;
      },
      runBound: async <T>(
        _capture: ProviderAuthBindingCapture,
        operation: () => Promise<T>,
      ) => operation(),
    } as unknown as ProviderAuthBindingAuthority;
    const providers = ["a", "b"].map(
      (id) => ({ id, name: id, baseUrl: `https://${id}.invalid` }) as unknown as Provider,
    );
    const models = {
      getProviders: () => providers,
      getProvider: (id: string) => providers.find((provider) => provider.id === id),
      getModels: (id: string) => [{ provider: id, baseUrl: `https://${id}.invalid` }],
      getAuth: async () => ({ auth: { apiKey: "secret" } }),
    } as unknown as Pick<
      Models,
      "getProviders" | "getProvider" | "getModels" | "getAuth"
    >;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = (providerId: string): ProviderUsageProbe => ({
      providerId,
      eligibility: () => ({ state: "eligible" }),
      acquire: async () => {
        calls += 1;
        await gate;
        return { state: "observed", facts: { windows: [], budgets: [] } };
      },
    });
    const authority = createProviderUsageAuthority({
      models,
      binding,
      probes: [probe("a"), probe("b")],
    });

    const first = authority.refresh("a");
    const second = authority.refresh("b");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(2);
    release();
    await Promise.all([first, second]);
  });

  it("de-duplicates concurrent refreshes only for the same complete binding", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () => {
            calls += 1;
            await gate;
            return { state: "observed", facts: { windows: [], budgets: [] } };
          },
        }),
      ],
    });

    const first = authority.refresh("fixture");
    const second = authority.refresh("fixture");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it("keeps a caller signal separate from shared inflight ownership", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let acquireStartedResolve!: () => void;
    const acquireStarted = new Promise<void>((resolve) => {
      acquireStartedResolve = resolve;
    });
    let acquireSignal: AbortSignal | undefined;
    let calls = 0;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async ({ signal }) => {
            calls += 1;
            acquireSignal = signal;
            acquireStartedResolve();
            await new Promise<void>((_resolve, reject) => {
              const abort = (): void =>
                reject(signal.reason ?? new Error("Provider usage aborted"));
              if (signal.aborted) {
                abort();
                return;
              }
              signal.addEventListener("abort", abort, { once: true });
            });
            return { state: "observed", facts: { windows: [], budgets: [] } };
          },
        }),
      ],
    });

    const shared = authority.refresh("fixture");
    await acquireStarted;
    const waiter = new AbortController();
    const joined = authority.refresh("fixture", waiter.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(1);
    waiter.abort();
    await expect(joined).resolves.toMatchObject({
      refresh: {
        providerId: "fixture",
        outcome: "unavailable",
        reason: "network",
      },
    });
    expect(acquireSignal?.aborted).toBe(false);

    const closing = authority.close();
    expect(acquireSignal?.aborted).toBe(true);
    await closing;
    await expect(shared).resolves.toMatchObject({
      refresh: {
        providerId: "fixture",
        outcome: "unavailable",
        reason: "network",
      },
    });
  });

  it("does not start a shared refresh after close when capture completes late", async () => {
    const capture = managed("a", "g1", "s1");
    const bindings = createBinding(capture);
    let captureStartedResolve!: () => void;
    const captureStarted = new Promise<void>((resolve) => {
      captureStartedResolve = resolve;
    });
    let releaseCaptureResolve!: () => void;
    const releaseCapture = new Promise<void>((resolve) => {
      releaseCaptureResolve = resolve;
    });
    const binding = {
      capture: async () => {
        captureStartedResolve();
        await releaseCapture;
        return capture;
      },
      publishIfCurrent: bindings.binding.publishIfCurrent,
      runBound: bindings.binding.runBound,
    } as unknown as ProviderAuthBindingAuthority;
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let probeCalls = 0;
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding,
      probes: [
        observedProbe({
          acquire: async () => {
            probeCalls += 1;
            return { state: "observed", facts: { windows: [], budgets: [] } };
          },
        }),
      ],
    });

    const refresh = authority.refresh("fixture");
    await captureStarted;
    await authority.close();
    releaseCaptureResolve();

    await expect(refresh).resolves.toMatchObject({
      refresh: {
        providerId: "fixture",
        outcome: "unavailable",
        reason: "network",
      },
    });
    expect(models.authCalls()).toBe(0);
    expect(probeCalls).toBe(0);
  });

  it("shares one close completion across concurrent callers", async () => {
    const bindings = createBinding(managed("a", "g1", "s1"));
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [
        observedProbe({
          acquire: async () => {
            await gate;
            return { state: "observed", facts: { windows: [], budgets: [] } };
          },
        }),
      ],
    });

    const shared = authority.refresh("fixture");
    const firstClose = authority.close();
    const secondClose = authority.close();
    expect(firstClose).toBe(secondClose);
    release();
    await Promise.all([shared, firstClose, secondClose]);
  });

  it("rejects passive publication after close", async () => {
    const capture = managed("a", "g1", "s1");
    const bindings = createBinding(capture);
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [observedProbe()],
    });

    await authority.close();

    await expect(authority.observePassive(
      "fixture",
      capture,
      "https://fixture.invalid",
      {
        windows: [{ kind: "weekly", usedPercent: 25 }],
        budgets: [],
      },
    )).resolves.toBe(false);
  });

  it("does not publish a passive observation when close wins the publication race", async () => {
    const capture = managed("a", "g1", "s1");
    const bindings = createBinding(capture);
    let publishStartedResolve!: () => void;
    const publishStarted = new Promise<void>((resolve) => {
      publishStartedResolve = resolve;
    });
    let releasePublishResolve!: () => void;
    const releasePublish = new Promise<void>((resolve) => {
      releasePublishResolve = resolve;
    });
    const binding = {
      capture: bindings.binding.capture,
      runBound: bindings.binding.runBound,
      publishIfCurrent: async (
        captured: ProviderAuthBindingCapture,
        publish: () => Promise<void> | void,
      ) => {
        publishStartedResolve();
        await releasePublish;
        return bindings.binding.publishIfCurrent(captured, publish);
      },
    } as unknown as ProviderAuthBindingAuthority;
    const models = createModels({
      baseUrl: "https://fixture.invalid",
      auth: { auth: { apiKey: "secret" } },
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding,
      probes: [observedProbe()],
    });

    const passive = authority.observePassive(
      "fixture",
      capture,
      "https://fixture.invalid",
      {
        windows: [{ kind: "weekly", usedPercent: 25 }],
        budgets: [],
      },
    );
    await publishStarted;
    await authority.close();
    releasePublishResolve();

    await expect(passive).resolves.toBe(false);
    await expect(authority.query()).resolves.toMatchObject({
      providers: [
        {
          providerId: "fixture",
          state: "unobserved",
        },
      ],
    });
  });
});
