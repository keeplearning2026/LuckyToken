import type { AuthResult, Models, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProviderAuthBindingAuthority,
  ProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";
import { ProviderAuthBindingError } from "../../src/credentials/profile-contract.js";
import { createProviderUsageAutoRefresh } from "../../src/provider-usage/auto-refresh.js";
import { createProviderUsageAuthority } from "../../src/provider-usage/authority.js";
import type {
  ProviderUsageAuthority,
  ProviderUsageFacts,
  ProviderUsageProbe,
  ProviderUsageProbeInput,
  ProviderUsageProbeResult,
  ProviderUsageSnapshot,
} from "../../src/provider-usage/contract.js";

/**
 * Plan section 6 / acceptance 13, 14, and 23: the external Codex login's
 * usage chain. The fixture mirrors the credential boundary's real rules —
 * publication is bound to the revision the operation actually resolved, and
 * capture identity is the account plus the document revision. Nothing here
 * reads a real CODEX_HOME or auth.json.
 */

const PROVIDER_ID = "openai-codex";
const DESTINATION = "https://chatgpt.com/backend-api";

interface ExternalFileState {
  readonly accountId: string;
  readonly tokenRevision: string;
}

type ExternalCapture = Extract<
  ProviderAuthBindingCapture,
  { readonly facts: { readonly kind: "external" } }
>;

function externalCapture(
  file: ExternalFileState,
): ExternalCapture {
  return Object.freeze({
    facts: Object.freeze({
      kind: "external" as const,
      providerId: PROVIDER_ID,
      authType: "oauth" as const,
      authMethodLabel: "Codex (ChatGPT)",
      displayName: "Codex login",
      canonicalPath: "fixture-codex-home/auth.json",
      accountId: file.accountId,
      tokenRevision: file.tokenRevision,
    }),
  });
}

function createExternalBinding(initial: ExternalFileState) {
  let file: ExternalFileState = { ...initial };
  let lastCapture: ExternalCapture | undefined;
  const resolvedRevisions = new WeakMap<object, string>();
  const binding = {
    async capture(): Promise<ProviderAuthBindingCapture> {
      const capture = externalCapture(file);
      lastCapture = capture;
      resolvedRevisions.set(capture, file.tokenRevision);
      return capture;
    },
    async publishIfCurrent(
      capture: ExternalCapture,
      publish: (assertCurrent: () => void) => Promise<void> | void,
    ): Promise<boolean> {
      const resolved = resolvedRevisions.get(capture);
      const matches = (): boolean =>
        file.accountId === capture.facts.accountId &&
        file.tokenRevision === resolved;
      if (!matches()) return false;
      await publish(() => {
        if (!matches()) throw new Error("superseded external revision");
      });
      return matches();
    },
    async runBound<T>(
      capture: ExternalCapture,
      operation: () => Promise<T>,
    ): Promise<T> {
      if (file.accountId !== capture.facts.accountId) {
        throw new Error("stale external binding");
      }
      return operation();
    },
  } as unknown as ProviderAuthBindingAuthority;
  return {
    binding,
    file: (): ExternalFileState => ({ ...file }),
    capture: (): ExternalCapture => {
      if (lastCapture === undefined) throw new Error("No external capture yet");
      return lastCapture;
    },
    setFile(next: Partial<ExternalFileState>): void {
      file = { ...file, ...next };
    },
    /** Records the revision a delegated resolution actually used, exactly as
     * the credential boundary mutates its captured scope. */
    useRevision(capture: ExternalCapture, revision: string): void {
      resolvedRevisions.set(capture, revision);
    },
  };
}

function createModels(options: {
  readonly getAuth: (
    providerId: string,
  ) => Promise<AuthResult | undefined>;
}) {
  let authCalls = 0;
  const provider = {
    id: PROVIDER_ID,
    name: "OpenAI Codex",
    baseUrl: DESTINATION,
  } as unknown as Provider;
  const models = {
    getProviders: () => [provider],
    getProvider: (id: string) => (id === PROVIDER_ID ? provider : undefined),
    getModels: () => [{ provider: PROVIDER_ID, baseUrl: DESTINATION }],
    getAuth: async () => {
      authCalls += 1;
      return options.getAuth(PROVIDER_ID);
    },
  } as unknown as Pick<
    Models,
    "getProviders" | "getProvider" | "getModels" | "getAuth"
  >;
  return { models, authCalls: () => authCalls };
}

function observed(usedPercent: number): ProviderUsageProbeResult {
  const facts: ProviderUsageFacts = {
    windows: [{ kind: "weekly", usedPercent }],
    budgets: [],
  };
  return Object.freeze({ state: "observed", facts });
}

function createProbe(
  acquire: (input: ProviderUsageProbeInput) => Promise<ProviderUsageProbeResult>,
): { readonly probe: ProviderUsageProbe; readonly calls: () => number } {
  let calls = 0;
  return {
    probe: Object.freeze({
      providerId: PROVIDER_ID,
      eligibility: () => Object.freeze({ state: "eligible" as const }),
      acquire: async (input: ProviderUsageProbeInput) => {
        calls += 1;
        return acquire(input);
      },
    }),
    calls: () => calls,
  };
}

const oauthAuth: AuthResult = Object.freeze({
  auth: Object.freeze({ apiKey: "fixture-access-token" }),
  source: "oauth",
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Provider usage external Codex state", () => {
  it("reports a bounded transient state and recovers once the source resolves", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    let failing = true;
    const models = createModels({
      getAuth: async () => {
        if (failing) {
          throw new ProviderAuthBindingError(
            "external_unavailable",
            "External Codex credential is unavailable; refresh it through Codex",
          );
        }
        return oauthAuth;
      },
    });
    const { probe, calls } = createProbe(async () => observed(31));
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
      now: () => 1,
    });

    const failed = await authority.refresh(PROVIDER_ID);
    expect(failed.refresh).toEqual({
      providerId: PROVIDER_ID,
      outcome: "unavailable",
      reason: "temporary",
    });
    expect(failed.snapshot.providers[0]).toEqual({
      providerId: PROVIDER_ID,
      state: "unavailable",
      reason: "temporary",
    });
    expect(calls()).toBe(0);

    failing = false;
    const recovered = await authority.refresh(PROVIDER_ID);
    expect(recovered.refresh).toEqual({
      providerId: PROVIDER_ID,
      outcome: "succeeded",
    });
    expect(recovered.snapshot.providers[0]).toMatchObject({
      state: "observed",
      refreshable: true,
      observation: { windows: [{ kind: "weekly", usedPercent: 31 }] },
    });

    await authority.close();
  });

  it("sees a wrapped credential-boundary failure through the cause chain", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({
      getAuth: async () => {
        // Production shape: Pi wraps the credential boundary's typed error.
        throw new Error("Credential store read failed", {
          cause: new ProviderAuthBindingError(
            "external_unavailable",
            "External Codex credential is unavailable",
          ),
        });
      },
    });
    const { probe } = createProbe(async () => observed(1));
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
    });

    await expect(authority.refresh(PROVIDER_ID)).resolves.toMatchObject({
      refresh: { outcome: "unavailable", reason: "temporary" },
    });
    await authority.close();
  });

  it("reports a changed account as account_change instead of reusing quota", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({
      getAuth: async () => {
        throw new ProviderAuthBindingError(
          "stale_binding",
          "External Codex credential account changed since capture",
        );
      },
    });
    const { probe } = createProbe(async () => observed(1));
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
    });

    await expect(authority.refresh(PROVIDER_ID)).resolves.toMatchObject({
      refresh: { outcome: "unavailable", reason: "account_change" },
    });
    await authority.close();
  });

  it("classifies the authority deadline as timeout", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({ getAuth: async () => oauthAuth });
    const { probe } = createProbe(
      ({ signal }) =>
        new Promise<ProviderUsageProbeResult>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
      refreshTimeoutMs: 25,
    });

    await expect(authority.refresh(PROVIDER_ID)).resolves.toMatchObject({
      refresh: { outcome: "unavailable", reason: "timeout" },
    });
    await expect(authority.query()).resolves.toMatchObject({
      providers: [
        { providerId: PROVIDER_ID, state: "unavailable", reason: "timeout" },
      ],
    });
    await authority.close();
  });

  it("stops network attempts after documented terminal evidence until the file changes", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({ getAuth: async () => oauthAuth });
    let reject = true;
    const { probe, calls } = createProbe(async () =>
      reject
        ? { state: "unavailable", reason: "auth" }
        : observed(12),
    );
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
      now: () => 5,
    });

    // The probe's structured auth rejection is the documented terminal
    // evidence for an external credential the boundary already verified.
    const terminal = await authority.refresh(PROVIDER_ID);
    expect(terminal.refresh).toEqual({
      providerId: PROVIDER_ID,
      outcome: "unavailable",
      reason: "terminal",
    });
    expect(calls()).toBe(1);
    expect(terminal.snapshot.providers[0]).toEqual({
      providerId: PROVIDER_ID,
      state: "unavailable",
      reason: "terminal",
    });

    // Same revision: no network attempt and no auth resolution.
    const retried = await authority.refresh(PROVIDER_ID);
    expect(retried.refresh).toEqual({
      providerId: PROVIDER_ID,
      outcome: "unavailable",
      reason: "terminal",
    });
    expect(calls()).toBe(1);
    expect(models.authCalls()).toBe(1);

    // A changed document revision resumes the attempts.
    reject = false;
    bindings.setFile({ tokenRevision: "r2" });
    const recovered = await authority.refresh(PROVIDER_ID);
    expect(recovered.refresh).toEqual({
      providerId: PROVIDER_ID,
      outcome: "succeeded",
    });
    expect(calls()).toBe(2);
    expect(recovered.snapshot.providers[0]).toMatchObject({
      state: "observed",
      observation: { windows: [{ kind: "weekly", usedPercent: 12 }] },
    });

    await authority.close();
  });

  it("keeps the last-known same-account observation across a revision change", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({ getAuth: async () => oauthAuth });
    const { probe } = createProbe(async () => observed(44));
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
      now: () => 9,
    });

    await authority.refresh(PROVIDER_ID);
    bindings.setFile({ tokenRevision: "r2" });

    await expect(authority.query()).resolves.toMatchObject({
      providers: [
        {
          state: "observed",
          refreshable: true,
          observation: {
            providerId: PROVIDER_ID,
            observedAt: 9,
            windows: [{ kind: "weekly", usedPercent: 44 }],
          },
        },
      ],
    });
    await authority.close();
  });

  it("never carries an observation over to a different account", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({ getAuth: async () => oauthAuth });
    const { probe } = createProbe(async () => observed(44));
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
      now: () => 9,
    });

    await authority.refresh(PROVIDER_ID);
    bindings.setFile({ accountId: "acct-b", tokenRevision: "r2" });

    await expect(authority.query()).resolves.toMatchObject({
      providers: [{ providerId: PROVIDER_ID, state: "unobserved" }],
    });
    await authority.close();
  });

  it("rejects a late response from a superseded revision", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({ getAuth: async () => oauthAuth });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { probe } = createProbe(async () => {
      await gate;
      return observed(80);
    });
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
      now: () => 3,
    });

    const pending = authority.refresh(PROVIDER_ID);
    await Promise.resolve();
    // The Codex-owned document rotates while the acquisition is in flight.
    bindings.setFile({ tokenRevision: "r2" });
    release();

    await expect(pending).resolves.toMatchObject({
      refresh: { providerId: PROVIDER_ID, outcome: "superseded" },
    });
    await expect(authority.query()).resolves.toMatchObject({
      providers: [{ providerId: PROVIDER_ID, state: "unobserved" }],
    });
    await authority.close();
  });

  it("publishes through the credential guard after a delegated refresh advances the revision", async () => {
    const bindings = createExternalBinding({
      accountId: "acct-a",
      tokenRevision: "r1",
    });
    const models = createModels({
      getAuth: async () => {
        // A delegated Codex refresh rewrote the file; the boundary records the
        // revision the operation actually resolved. Publication compares
        // against that revision, not against the capture-time one.
        bindings.setFile({ tokenRevision: "r2" });
        bindings.useRevision(bindings.capture(), "r2");
        return oauthAuth;
      },
    });
    const { probe } = createProbe(async () => observed(58));
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding: bindings.binding,
      probes: [probe],
      now: () => 4,
    });

    const result = await authority.refresh(PROVIDER_ID);
    expect(result.refresh).toEqual({
      providerId: PROVIDER_ID,
      outcome: "succeeded",
    });
    expect(result.snapshot.providers[0]).toMatchObject({
      state: "observed",
      observation: { windows: [{ kind: "weekly", usedPercent: 58 }] },
    });
    await authority.close();
  });

  it("keeps managed bindings free of persisted failure state", async () => {
    const capture: ProviderAuthBindingCapture = Object.freeze({
      facts: Object.freeze({
        kind: "managed" as const,
        providerId: PROVIDER_ID,
        credentialId: "credential-a",
        authType: "oauth" as const,
        authMethodLabel: "ChatGPT sign-in",
        displayName: "Managed login",
        credentialGeneration: "g1",
        selectionGeneration: "s1",
      }),
    });
    const binding = {
      capture: async () => capture,
      publishIfCurrent: async (
        _capture: ProviderAuthBindingCapture,
        publish: (assertCurrent: () => void) => Promise<void> | void,
      ) => {
        await publish(() => undefined);
        return true;
      },
      runBound: async <T>(
        _capture: ProviderAuthBindingCapture,
        operation: () => Promise<T>,
      ) => operation(),
    } as unknown as ProviderAuthBindingAuthority;
    const models = createModels({ getAuth: async () => oauthAuth });
    const { probe } = createProbe(async () => ({
      state: "unavailable",
      reason: "auth",
    }));
    const authority = createProviderUsageAuthority({
      models: models.models,
      binding,
      probes: [probe],
    });

    await expect(authority.refresh(PROVIDER_ID)).resolves.toMatchObject({
      refresh: { outcome: "unavailable", reason: "auth" },
    });
    await expect(authority.query()).resolves.toMatchObject({
      providers: [{ providerId: PROVIDER_ID, state: "unobserved" }],
    });
    await authority.close();
  });
});

describe("Provider usage automatic refresh selection", () => {
  function runner(snapshot: ProviderUsageSnapshot): {
    readonly refresh: ReturnType<typeof vi.fn>;
    readonly runner: ReturnType<typeof createProviderUsageAutoRefresh>;
  } {
    const refresh = vi.fn(async (providerId: string) => {
      void providerId;
    });
    const authority: Pick<ProviderUsageAuthority, "query" | "refresh"> = {
      query: async () => snapshot,
      refresh: async (providerId) => {
        void refresh(providerId);
        return {
          snapshot,
          refresh: { providerId, outcome: "succeeded" as const },
        };
      },
    };
    return {
      refresh,
      runner: createProviderUsageAutoRefresh({
        authority,
        intervalMinutes: () => 15,
      }),
    };
  }

  it("retries bounded transient external failures but never terminal evidence", async () => {
    vi.useFakeTimers();
    const { refresh, runner: autoRefresh } = runner({
      providers: [
        { providerId: PROVIDER_ID, state: "unavailable", reason: "temporary" },
        { providerId: "openai-codex-terminal", state: "unavailable", reason: "terminal" },
        {
          state: "observed",
          refreshable: true,
          observation: {
            providerId: "openai-codex-observed",
            observedAt: 1,
            windows: [],
            budgets: [],
          },
        },
      ],
    });
    autoRefresh.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual([
      "openai-codex",
      "openai-codex-observed",
    ]);
    await autoRefresh.close();
  });
});
