import { readCredentialDocumentFile } from "../../src/credentials/credential-document.js";
import { parseCodexInternalAuth } from "../../src/credentials/codex-internal-auth.js";
import {
  createFileProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { createProviderUsageAuthority } from "../../src/provider-usage/authority.js";
import type { ProviderUsageAuthority } from "../../src/provider-usage/contract.js";
import { createBuiltInProviderUsageProbes } from "../../src/provider-usage/registry.js";
import { codexExternalAuthPath } from "../../src/credentials/codex-auth.js";
import { createProviderRuntime } from "../../src/providers/runtime.js";
import { loadBundledProviderConfigurations } from "../../src/providers/bundled-configuration.js";
import {
  createCodexNativeCatalogSource,
} from "../../src/integrations/codex/native-catalog-source.js";
import { resolveCodexHome } from "../../src/integrations/codex/home.js";
import { startTokenHttpServer } from "../../src/server.js";
import { createConfiguredTokenDataPlane } from "../support/configured-data-plane.js";
import {
  createOnlinePublicModelAuthority,
  reconcileOnlinePublicModels,
} from "./public-model-fixture.js";
import { classifyCodexOnlineLane, codexOnlineGate, type CodexOnlineLane as LaneProbeResult } from "./openai-codex-gate.js";

const DEDICATED_CODEX_AUTH_HOME_ENV = "TOKEN_CODEX_TEST_AUTH_HOME";
const PROVIDER_ID = "openai-codex";

/** Real-login certification imports parsed material into temporary Token-owned
 * storage. All CLI/native-catalog processes receive the temporary CODEX_HOME.
 * The explicitly selected source auth path is read only and never rewritten. */
async function run(): Promise<void> {
  const dedicatedHome = process.env[DEDICATED_CODEX_AUTH_HOME_ENV]?.trim();
  const codexHome =
    dedicatedHome === undefined || dedicatedHome.length === 0
      ? resolveCodexHome()
      : resolve(dedicatedHome);
  const loginSource =
    dedicatedHome === undefined || dedicatedHome.length === 0 ? "local" : "dedicated";
  const authPath = codexExternalAuthPath(codexHome);
  const initial = await readCredentialDocumentFile(authPath);
  if (initial.state !== "ok") {
    process.stdout.write(`${JSON.stringify({
      result: "skip",
      reason: "codex_login_unavailable",
      codexHome,
      loginSource,
      env: DEDICATED_CODEX_AUTH_HOME_ENV,
      detail: initial.state,
    })}\n`);
    return;
  }
  const authBefore = await stat(authPath);
  assert.ok(parseCodexInternalAuth(initial.raw), "local Codex login must contain a parseable ChatGPT credential");
  const root = await mkdtemp(join(tmpdir(), "Token-openai-codex-online-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  let server: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;
  let composition: Awaited<ReturnType<typeof createConfiguredTokenDataPlane>> | undefined;
  let usage: ProviderUsageAuthority | undefined;
  try {
    const stateDirectory = join(root, ".Token");
    const piDirectory = join(stateDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    const configPath = join(stateDirectory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "token-config-v2",
        server: { port: 0 },
        clientProtocols: {
          "anthropic-messages": {},
          "openai-responses": { stateFile: "state/openai-responses.json" },
        },
        providerPackages: {},
        pi: { directory: "pi" },
      }),
      "utf8",
    );
    const config = await loadTokenCliConfig(configPath);
    const nativeCatalogSource = createCodexNativeCatalogSource({ codexHome: root });
    const piIds = new Set(
      (builtinProviders().find((builtin) => builtin.id === PROVIDER_ID)?.getModels() ?? [])
        .map((model) => model.id),
    );
    const nativeSnapshot = await nativeCatalogSource.load();
    const nativeIds = nativeSnapshot.entries.filter((entry) => entry.visibility === "list" && entry.supported_in_api === true).map((entry) => entry.slug);
    assert.ok(nativeIds.length > 0, "native catalog must expose at least one listable model");
    const missingNative = nativeIds.filter((id) => !piIds.has(id));
    assert.ok(
      missingNative.length > 0,
      "the local Codex login must expose at least one Pi-missing native model",
    );
    const laneProbeModel = process.env.TOKEN_CODEX_TEST_MODEL?.trim() || missingNative[0]!;
    assert.ok(nativeIds.includes(laneProbeModel), "the selected known-available test model must be native-listable");
    const laneAlias = `${PROVIDER_ID}/${laneProbeModel}`;
    const publicModelAuthority = await createOnlinePublicModelAuthority({
      path: join(stateDirectory, "public-models.json"),
      endpoint: { host: "127.0.0.1", port: 3000 },
      alias: laneAlias,
      providerId: PROVIDER_ID,
      modelId: laneProbeModel,
    });
    const bundled = await loadBundledProviderConfigurations(join(stateDirectory, "commandcode-models.json"));
    const credentialRecordStore = createFileProviderCredentialRecordStore({ piDirectory, createRevision: randomUUID });
    const providerRuntime = await nativeCatalogSource.withSnapshot(nativeSnapshot, () => createProviderRuntime({
      piDirectory, modelsJsonPath: config.pi.modelsJson, codexHome,
      bundledProviderConfigurations: bundled.configurations, userProviderPackages: config.providerPackages,
      fetch: globalThis.fetch, nativeCatalogSource,
      credentialRecordStore,
    }));
    composition = await createConfiguredTokenDataPlane({
      config,
      fetch: globalThis.fetch,
      nativeCatalogSource,
      providerRuntime,
      publicModelAuthority,
    });
    await reconcileOnlinePublicModels(
      publicModelAuthority,
      composition.catalog.models,
      PROVIDER_ID,
    );
    server = await startTokenHttpServer({
      runtime: composition.runtime,
      host: "127.0.0.1",
      port: 0,
    });

    const localMethod = providerRuntime.localAcquisitionMethods.find(
      (method) => method.providerId === PROVIDER_ID,
    );
    assert.ok(localMethod, "Codex local OAuth acquisition must be available");
    const localLogin = await composition.credentialManagement.acquireLocal({
      providerId: PROVIDER_ID,
      displayName: "Local Codex",
      acquisition: localMethod.acquisition,
    });
    assert.equal(localLogin.outcome, "ok");

    const projection = await composition.credentialManagement.query([PROVIDER_ID]);
    const provider = projection.providers.find(
      (candidate) => candidate.providerId === PROVIDER_ID,
    );
    assert.equal(provider?.profiles.length, 1, "local login must create one ordinary Profile");
    assert.equal(provider?.activeCredentialId, provider?.profiles[0]?.credentialId);
    assert.equal(provider?.profiles[0]?.acquisitionKind, "local_oauth");
    assert.equal(provider?.ambient, undefined, "referenced credentials have no ambient presentation");
    assert.ok(!JSON.stringify(provider).includes("strategyId"));
    assert.ok(!JSON.stringify(provider).includes("codex_local"));
    const importedRecord = (await credentialRecordStore.read(PROVIDER_ID))!;
    const imported = importedRecord.profiles[0]!;
    assert.equal(imported.acquisitionKind, "local_oauth");
    assert.equal(imported.reference.owner, "external");
    assert.ok(imported.reference.path.endsWith("auth.json"));

    const servedIds = new Set(
      composition.catalog.models.getModels(PROVIDER_ID).map((model) => model.id),
    );
    for (const id of nativeIds) {
      assert.ok(servedIds.has(id), `served catalog must include native model ${id}`);
    }
    for (const id of piIds) {
      assert.ok(servedIds.has(id), `served catalog must keep Pi model ${id}`);
    }

    usage = createProviderUsageAuthority({
      models: composition.catalog.models,
      binding: composition.providerAuthBindings,
      profileSnapshot: () => composition!.credentialManagement.snapshot(),
      probes: createBuiltInProviderUsageProbes(globalThis.fetch),
    });
    const usageResult = await usage.refresh(PROVIDER_ID, AbortSignal.timeout(60_000));
    assert.equal(
      usageResult.refresh.outcome,
      "succeeded",
      "external Codex usage must succeed",
    );

    // Real lane probes for an appended, Pi-missing model. A Provider Native
    // Responses request exercises the Native lane; an Anthropic Messages
    // request exercises Semantic Conversion through Pi. An account without
    // entitlement is recorded, and the credential must stay usable.
    const nativeResponses = await probeNativeResponses(server.origin, laneAlias);
    const semanticMessages = await probeSemanticMessages(server.origin, laneAlias);
    // A documented entitlement rejection records incomplete coverage. It
    // cannot certify either lane or produce a passing suite.
    const credentialAfterProbes =
      await composition.providerAuthBindings.capture(PROVIDER_ID);
    const credentialStayedUsable =
      credentialAfterProbes.facts.kind === "profile" &&
      credentialAfterProbes.facts.credentialId === imported.credentialId;

    const usageAfterProbes = await usage.refresh(
      PROVIDER_ID,
      AbortSignal.timeout(60_000),
    );
    await usage.close();
    assert.equal(
      usageAfterProbes.refresh.outcome,
      "succeeded",
      "usage must stay usable after both lane probes",
    );
    const usageStateAfterProbes = usageAfterProbes.snapshot.profiles.find(
      (entry) =>
        entry.providerId === PROVIDER_ID &&
        entry.credentialId === imported.credentialId,
    );
    const credentialStayedNonTerminal = !(
      usageStateAfterProbes?.state === "unavailable" &&
      usageStateAfterProbes.reason === "terminal"
    );
    assert.ok(
      credentialStayedNonTerminal,
      "lane rejections must not make the external credential terminal",
    );

    const final = await readCredentialDocumentFile(authPath);
    assert.equal(
      final.state,
      "ok",
      "source must remain readable after every consumer",
    );
    assert.ok(final.state === "ok");
    assert.equal(
      final.revision,
      initial.revision,
      "Token must not rewrite the original auth.json",
    );
    const authAfter = await stat(authPath);
    const rotation = "not_required" as const;

    const initialGate = codexOnlineGate({
      usage: usageResult.refresh.outcome,
      native: nativeResponses,
      semantic: semanticMessages,
      rotation,
      usable: credentialStayedUsable,
      nonTerminal: credentialStayedNonTerminal,
    });
    const switches: readonly unknown[] = [];
    const gate = initialGate;
    if (gate.result !== "pass") process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({
      ...gate,
      codexHome,
      loginSource,
      connected: true,
      nativeListable: nativeIds.length,
      piMissingNative: missingNative,
      servedModelCount: servedIds.size,
      usage: usageResult.refresh,
      rotation,
      laneProbeModel,
      laneAlias,
      nativeResponses,
      semanticMessages,
      switches,
      credentialStayedUsable,
      credentialStayedNonTerminal,
      credentialBoundary: {
        kind: "profile",
        acquisitionKind: "local_oauth",
        authType: "oauth",
        referenceOwner: "external",
        sourceReadOnly: true,
      },
      authFile: { contentUnchanged: final.revision === initial.revision,
        mtimeUnchanged: authAfter.mtimeMs === authBefore.mtimeMs,
        sizeBefore: authBefore.size, sizeAfter: authAfter.size,
        sha256Before: initial.revision, sha256After: final.revision },
      testState: { temporaryCodexHome: true, importedCredential: true },
    })}\n`);
  } finally {
    await usage?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await composition?.close().catch(() => undefined);
    // This dedicated probe process owns all its Pi sessions. The public
    // adapter caches WebSockets for reuse; release them before process exit.
    closeOpenAICodexWebSocketSessions();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
}

async function probeNativeResponses(
  origin: string,
  alias: string,
): Promise<LaneProbeResult> {
  const sessionId = randomUUID();
  const response = await fetch(`${origin}/v1/responses`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      authorization: "Bearer unused-local-client-token",
      "content-type": "application/json",
      "session_id": sessionId,
      "x-client-request-id": sessionId,
    },
    // The Codex client body: the Codex backend rejects `max_output_tokens`,
    // exactly as the real Codex CLI request would not send it.
    body: JSON.stringify({
      model: alias,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Reply with the single word PROBE." }],
        },
      ],
      store: false,
      stream: true,
      instructions: "You are a helpful assistant.",
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: sessionId,
      tool_choice: "auto",
      parallel_tool_calls: true,
      text: { verbosity: "low" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  return classifyCodexOnlineLane(response.status, await response.text());
}

async function probeSemanticMessages(
  origin: string,
  alias: string,
): Promise<LaneProbeResult> {
  const response = await fetch(`${origin}/v1/messages`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      authorization: "Bearer unused-local-client-token",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: alias,
      max_tokens: 32,
      messages: [{ role: "user", content: "Reply with the single word PROBE." }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  return classifyCodexOnlineLane(response.status, await response.text());
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `openai-codex provider online suite failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
