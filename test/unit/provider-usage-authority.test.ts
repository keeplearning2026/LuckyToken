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

function managed(
  credentialId: string,
  credentialGeneration: string,
  selectionGeneration: string,
  authType: "api_key" | "oauth" = "api_key",
): ProviderAuthBindingCapture {
  return Object.freeze({
    facts: Object.freeze({
      kind: "managed" as const,
      providerId: "fixture",
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
      publish: (assertCurrent: () => void) => Promise<void> | void,
    ) => {
      beforePublish?.();
      beforePublish = undefined;
      if (!sameCapture(capture, current)) return false;
      const assertCurrent = () => {
        if (!sameCapture(capture, current)) throw new Error("stale");
      };
      await publish(assertCurrent);
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
  readonly auth?: AuthResult;
  readonly onGetAuth?: (signal: AbortSignal | undefined) => void;
}) {
  let authCalls = 0;
  let baseUrl = options.baseUrl;
  const models = {
    getProviders: () => [
      {
        id: "fixture",
        name: "Fixture",
        ...(baseUrl === undefined ? {} : { baseUrl }),
      } as unknown as Provider,
    ],
    getProvider: (id: string) =>
      id === "fixture"
        ? ({
            id: "fixture",
            name: "Fixture",
            ...(baseUrl === undefined ? {} : { baseUrl }),
          } as unknown as Provider)
        : undefined,
    getModels: () =>
      baseUrl === undefined
        ? []
        : [{ provider: "fixture", baseUrl }],
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
      baseUrl = next;
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

    expect(await authority.observePassive("fixture", a, facts)).toBe(true);
    expect((await authority.query()).providers[0]).toMatchObject({
      state: "observed",
      observation: {
        observedAt: 9,
        windows: [{ kind: "five_hour", usedPercent: 50 }],
      },
    });

    bindings.setCurrent(b);
    expect(await authority.observePassive("fixture", a, facts)).toBe(false);
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
      await authority.observePassive("fixture", capture, {
        windows: [{ kind: "weekly", usedPercent: 22 }],
        budgets: [],
      }),
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

  it("merges partial passive observations for the same current binding", async () => {
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

    await authority.observePassive("fixture", capture, {
      windows: [{ kind: "weekly", usedPercent: 20 }],
      budgets: [],
    });
    await authority.observePassive("fixture", capture, {
      windows: [{ kind: "five_hour", usedPercent: 50 }],
      budgets: [],
    });

    expect((await authority.query()).providers[0]).toEqual({
      state: "observed",
      refreshable: false,
      observation: {
        providerId: "fixture",
        observedAt: 2,
        windows: [
          { kind: "weekly", usedPercent: 20 },
          { kind: "five_hour", usedPercent: 50 },
        ],
        budgets: [],
      },
    });
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
});
