import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { ProviderPackageCreateInput } from "@token/provider-contract/package";
import type { LocalOAuthRegistration } from "@token/provider-contract/local-oauth";
import { DEFAULT_COMMANDCODE_MODEL_CATALOG } from "@token/commandcode-model-catalog";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createProviderRuntime } from "../../src/providers/runtime.js";
import { createBundledProviderConfigurations } from "../../src/providers/bundled-configuration.js";
import { createCredentialProfilesControlPlaneHandlers } from "../../src/credentials/profile-control-plane.js";
import { createCredentialManagementGuard } from "../../src/credentials/management.js";
import { bundledProviderImportModule } from "../support/bundled-provider-packages.js";
import { createSelectOAuthProvider } from "../support/auth-login-fixture.js";

const providerId = "fixture-local-oauth";

async function isolated(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "Token-local-registration-"));
  try {
    await mkdir(join(root, "codex-home"));
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function localCredential(raw: string): OAuthCredential | undefined {
  if (!raw.startsWith("owner:")) return undefined;
  return { type: "oauth", access: raw.slice(6), refresh: "owner-refresh", expires: Date.now() + 3_600_000 };
}

async function runtimeFor(root: string, registration: LocalOAuthRegistration | undefined) {
  const bundledImports = bundledProviderImportModule();
  return createProviderRuntime({
    piDirectory: join(root, "pi"),
    modelsJsonPath: join(root, "models.json"),
    codexHome: join(root, "codex-home"),
    bundledProviderConfigurations: createBundledProviderConfigurations(DEFAULT_COMMANDCODE_MODEL_CATALOG),
    userProviderPackages: { "@fixture/local-oauth": {} },
    fetch: async () => { throw new Error("No network expected"); },
    importModule: async (specifier) => specifier === "@fixture/local-oauth"
      ? { providerPackage: {
          contractVersion: 1,
          createProvider(input: ProviderPackageCreateInput) {
            if (registration !== undefined) input.host.registerLocalOAuth(registration);
            return createSelectOAuthProvider({ id: providerId });
          },
        } }
      : bundledImports(specifier),
  });
}

function handlersFor(runtime: Awaited<ReturnType<typeof runtimeFor>>) {
  return createCredentialProfilesControlPlaneHandlers({
    models: runtime.models,
    management: runtime.credentialManagement,
    binding: runtime.providerAuthBindings,
    managementGuard: createCredentialManagementGuard({ createId: randomUUID, now: Date.now }),
    localAcquisitionMethods: () => runtime.localAcquisitionMethods.map((method) => ({
      providerId: method.providerId, label: method.label(), icon: method.icon,
    })),
  });
}

async function login(
  runtime: Awaited<ReturnType<typeof runtimeFor>>,
  name = "Local account",
  signal = new AbortController().signal,
) {
  return handlersFor(runtime).auth({
    command: "login", providerId, acquisitionKind: "local_oauth", displayName: name,
  }, {
    signal,
    notify: async () => undefined,
    prompt: async () => { throw new Error("Local login must not prompt for credentials"); },
  });
}

async function authFor(runtime: Awaited<ReturnType<typeof runtimeFor>>) {
  const capture = await runtime.providerAuthBindings.capture(providerId);
  return runtime.providerAuthBindings.runBound(capture, () =>
    runtime.models.getAuth(runtime.models.getModels(providerId)[0]!),
  );
}

describe("Provider local OAuth registration", () => {
  it("provides a UI capability, persists one reference and restores dispatch after restart", async () => isolated(async (root) => {
    const path = join(root, "owner-auth.json");
    await writeFile(path, "owner:access-a");
    const acquire = vi.fn(async () => ({ owner: "external" as const, path }));
    const read = vi.fn(localCredential);
    const registration: LocalOAuthRegistration = {
      providerId, label: () => "Fixture local account", icon: "terminal", acquire, read,
    };
    const runtime = await runtimeFor(root, registration);
    const query = await handlersFor(runtime).auth({ command: "query" }, {
      signal: new AbortController().signal, notify: async () => undefined, prompt: async () => "",
    });
    expect(query.options?.providers.find((provider) => provider.providerId === providerId)?.acquisitionOptions)
      .toContainEqual(expect.objectContaining({ kind: "local_oauth", label: "Fixture local account", icon: "terminal" }));
    expect(acquire).not.toHaveBeenCalled();
    const added = await login(runtime);
    expect(added.outcome).toBe("ok");
    const profile = added.state.providers.find((provider) => provider.providerId === providerId)!.profiles[0]!;
    expect(profile.authMethodLabel).toBe("Fixture local account");
    const serialized = await readFile(join(root, "pi", "credential-profiles", `${providerId}.json`), "utf8");
    expect(serialized).toContain('"local_oauth"');
    expect(serialized).not.toContain("access-a");
    expect(serialized).not.toContain("owner-refresh");
    expect(serialized).not.toContain("strategyId");
    expect(await authFor(runtime)).toMatchObject({ auth: { apiKey: "access-a" } });
    expect((await login(runtime, "Duplicate")).outcome).toBe("duplicate");
    expect(acquire).toHaveBeenCalledTimes(1);

    await writeFile(path, "owner:access-b");
    const restarted = await runtimeFor(root, registration);
    expect(await authFor(restarted)).toMatchObject({ auth: { apiKey: "access-b" } });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.every((args) => args.length === 1 && typeof args[0] === "string")).toBe(true);
    expect(await readFile(path, "utf8")).toBe("owner:access-b");

    const missingRegistration = await runtimeFor(root, undefined);
    await expect(authFor(missingRegistration)).rejects.toThrow();
    const stillPresent = await missingRegistration.credentialManagement.query([providerId]);
    expect(stillPresent.providers[0]?.profiles[0]?.credentialId).toBe(profile.credentialId);
  }));

  it.each(["missing", "invalid", "throwing-parser", "wrong-type", "managed-reference", "no-reference"])(
    "does not create a Profile for %s acquisition", async (scenario) => isolated(async (root) => {
      const path = join(root, "owner-auth.json");
      if (scenario !== "missing") await writeFile(path, scenario === "invalid" ? "invalid" : "owner:secret-token");
      const runtime = await runtimeFor(root, {
        providerId, label: () => "Local", icon: "terminal",
        acquire: async () => scenario === "no-reference" ? null : {
          owner: scenario === "managed-reference" ? "managed" : "external", path,
        } as Awaited<ReturnType<LocalOAuthRegistration["acquire"]>>,
        read: scenario === "throwing-parser"
          ? () => { throw new Error("secret-token"); }
          : scenario === "wrong-type"
            ? () => ({ type: "api_key", key: "secret-token" }) as unknown as OAuthCredential
            : localCredential,
      });
      const result = await login(runtime);
      expect(result.outcome).not.toBe("ok");
      expect(JSON.stringify(result)).not.toContain("secret-token");
      expect(result.state.providers.find((provider) => provider.providerId === providerId)?.profiles ?? []).toEqual([]);
    }),
  );

  it("passes cancellation to discovery and prevents publication after cancellation", async () => isolated(async (root) => {
    const path = join(root, "owner-auth.json");
    await writeFile(path, "owner:secret-token");
    const controller = new AbortController();
    const read = vi.fn(localCredential);
    const runtime = await runtimeFor(root, {
      providerId, label: () => "Local", icon: "terminal", read,
      acquire: async (signal) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        controller.abort();
        expect(signal?.aborted).toBe(true);
        return { owner: "external", path };
      },
    });
    const result = await login(runtime, "Cancelled", controller.signal);
    expect(result.outcome).toBe("cancelled");
    expect(read).not.toHaveBeenCalled();
    expect(result.state.providers.find((provider) => provider.providerId === providerId)?.profiles ?? []).toEqual([]);
  }));

  it("does not publish a Profile when the parser triggers cancellation", async () => isolated(async (root) => {
    const path = join(root, "owner-auth.json");
    await writeFile(path, "owner:secret-token");
    const controller = new AbortController();
    const runtime = await runtimeFor(root, {
      providerId, label: () => "Local", icon: "terminal",
      acquire: async () => ({ owner: "external", path }),
      read: (raw) => {
        controller.abort();
        return localCredential(raw);
      },
    });
    const result = await login(runtime, "Cancelled", controller.signal);
    expect(result.outcome).toBe("cancelled");
    expect(result.state.providers.find((provider) => provider.providerId === providerId)?.profiles ?? []).toEqual([]);
  }));
});
