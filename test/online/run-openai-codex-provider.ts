import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import { createProviderUsageAuthority } from "../../src/provider-usage/authority.js";
import { createBuiltInProviderUsageProbes } from "../../src/provider-usage/registry.js";
import { createExternalCredentialSource } from "../../src/credentials/external-credential-source.js";
import { createCodexAppServerRefresher } from "../../src/credentials/codex-app-server-refresh.js";
import {
  codexExternalAuthPath,
  needsCodexRefresh,
  parseCodexExternalAuth,
  readCodexExternalAuth,
} from "../../src/credentials/external-auth.js";
import {
  codexDebugModelsInvocation,
  discoverCodexCommands,
} from "../../src/integrations/codex/runtime-discovery.js";
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEDICATED_CODEX_AUTH_HOME_ENV = "TOKEN_CODEX_TEST_AUTH_HOME";
const PROVIDER_ID = "openai-codex";

/**
 * Dedicated `openai-codex` online suite.
 *
 * The Codex home is `TOKEN_CODEX_TEST_AUTH_HOME` when set (dedicated test
 * login), otherwise the local Codex home (`CODEX_HOME` or `~/.codex`). The
 * document is only ever read: the suite never copies it, and a refresh runs
 * only through the Codex-native delegation this feature implements. When no
 * ChatGPT login is available the suite records a skip instead of mocking
 * anything.
 */
async function nativeListableIds(codexHome: string): Promise<readonly string[]> {
  const commands = await discoverCodexCommands({});
  for (const command of commands) {
    const invocation = codexDebugModelsInvocation(command, process.platform, process.env);
    try {
      const result = await execFileAsync(invocation.file, [...invocation.args], {
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: codexHome },
        windowsHide: true,
        timeout: 15_000,
        ...invocation.options,
      });
      const parsed = JSON.parse(result.stdout) as {
        models?: Array<{ slug?: unknown; visibility?: unknown; supported_in_api?: unknown }>;
      };
      return Object.freeze(
        (parsed.models ?? []).flatMap((entry) =>
          entry.visibility === "list" &&
          entry.supported_in_api === true &&
          typeof entry.slug === "string"
            ? [entry.slug]
            : [],
        ),
      );
    } catch {
      // Try the next discovered runtime.
    }
  }
  return Object.freeze([]);
}

async function run(): Promise<void> {
  const dedicatedHome = process.env[DEDICATED_CODEX_AUTH_HOME_ENV]?.trim();
  const codexHome =
    dedicatedHome === undefined || dedicatedHome.length === 0
      ? resolveCodexHome()
      : resolve(dedicatedHome);
  const loginSource =
    dedicatedHome === undefined || dedicatedHome.length === 0 ? "local" : "dedicated";
  const authPath = codexExternalAuthPath(codexHome);
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    process.stdout.write(`${JSON.stringify({
      result: "skip",
      reason: "codex_login_unavailable",
      codexHome,
      loginSource,
      env: DEDICATED_CODEX_AUTH_HOME_ENV,
    })}\n`);
    return;
  }
  const parsed = parseCodexExternalAuth(raw);
  if (parsed.state !== "ok") {
    process.stdout.write(`${JSON.stringify({
      result: "skip",
      reason: "codex_login_not_chatgpt",
      codexHome,
      loginSource,
      detail: parsed.reason,
    })}\n`);
    return;
  }
  // The external credential source, the Codex-delegated refresh, and the Codex
  // CLI all observe this one home.
  process.env.CODEX_HOME = codexHome;

  const root = await mkdtemp(join(tmpdir(), "Token-openai-codex-online-"));
  let server: Awaited<ReturnType<typeof startTokenHttpServer>> | undefined;
  let composition: Awaited<ReturnType<typeof createConfiguredTokenDataPlane>> | undefined;
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
    const nativeCatalogSource = createCodexNativeCatalogSource({ codexHome });
    const piIds = new Set(
      (builtinProviders().find((builtin) => builtin.id === PROVIDER_ID)?.getModels() ?? [])
        .map((model) => model.id),
    );
    const nativeIds = await nativeListableIds(codexHome);
    assert.ok(nativeIds.length > 0, "native catalog must expose at least one listable model");
    const missingNative = nativeIds.filter((id) => !piIds.has(id));
    assert.ok(
      missingNative.length > 0,
      "the local Codex login must expose at least one Pi-missing native model",
    );
    const laneProbeModel = missingNative[0]!;
    const laneAlias = `${PROVIDER_ID}/${laneProbeModel}`;
    const publicModelAuthority = await createOnlinePublicModelAuthority({
      path: join(stateDirectory, "public-models.json"),
      endpoint: { host: "127.0.0.1", port: 3000 },
      alias: laneAlias,
      providerId: PROVIDER_ID,
      modelId: laneProbeModel,
    });
    composition = await createConfiguredTokenDataPlane({
      config,
      fetch: globalThis.fetch,
      nativeCatalogSource,
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

    const projection = await composition.credentialManagement.query([PROVIDER_ID]);
    const provider = projection.providers.find(
      (candidate) => candidate.providerId === PROVIDER_ID,
    );
    assert.equal(
      provider?.ambient?.status,
      "connected",
      "external Codex login must be presented as connected",
    );

    const servedIds = new Set(
      composition.catalog.models.getModels(PROVIDER_ID).map((model) => model.id),
    );
    for (const id of nativeIds) {
      assert.ok(servedIds.has(id), `served catalog must include native model ${id}`);
    }
    for (const id of piIds) {
      assert.ok(servedIds.has(id), `served catalog must keep Pi model ${id}`);
    }

    const usage = createProviderUsageAuthority({
      models: composition.catalog.models,
      binding: composition.providerAuthBindings,
      probes: createBuiltInProviderUsageProbes(globalThis.fetch),
    });
    const usageResult = await usage.refresh(PROVIDER_ID, AbortSignal.timeout(60_000));
    assert.notEqual(
      usageResult.refresh.outcome,
      "unsupported",
      "an external Codex login must be usage-eligible",
    );

    // Real lane probes for an appended, Pi-missing model. A Provider Native
    // Responses request exercises the Native lane; an Anthropic Messages
    // request exercises Semantic Conversion through Pi. An account without
    // entitlement is recorded, and the credential must stay usable.
    const nativeResponses = await probeNativeResponses(server.origin, laneAlias);
    const semanticMessages = await probeSemanticMessages(server.origin, laneAlias);
    // A lane that errors (transport/5xx/non-4xx) fails the suite. A 4xx is
    // recorded instead: the account may simply lack entitlement to this
    // listable model (plan acceptance 31).
    assert.notEqual(nativeResponses.outcome, "error", nativeResponses.detail);
    assert.notEqual(semanticMessages.outcome, "error", semanticMessages.detail);
    const credentialAfterProbes = await readCodexExternalAuth(authPath);
    const credentialStayedUsable = credentialAfterProbes.state === "ok";
    // A rejected probe must never push the shared credential into a terminal
    // usage state (plan section 6 evidence rules).
    const usageAfterProbes = await usage.refresh(
      PROVIDER_ID,
      AbortSignal.timeout(60_000),
    );
    await usage.close();
    const usageStateAfterProbes = usageAfterProbes.snapshot.providers.find(
      (entry) =>
        (entry.state === "observed"
          ? entry.observation.providerId
          : entry.providerId) === PROVIDER_ID,
    );
    const credentialStayedNonTerminal = !(
      usageStateAfterProbes?.state === "unavailable" &&
      usageStateAfterProbes.reason === "terminal"
    );
    assert.ok(
      credentialStayedNonTerminal,
      "lane rejections must not make the external credential terminal",
    );

    const before = await readCodexExternalAuth(authPath);
    assert.equal(before.state, "ok");
    let rotation: "observed" | "not_required" | "delegation_failed" = "not_required";
    if (before.state === "ok" && needsCodexRefresh(before, Date.now())) {
      const source = createExternalCredentialSource({
        authPath,
        refresher: createCodexAppServerRefresher({ codexHome }),
      });
      const resolution = await source.resolve();
      if (resolution.state !== "ok") {
        rotation = "delegation_failed";
      } else {
        const after = await readCodexExternalAuth(authPath);
        assert.equal(after.state, "ok");
        if (after.state === "ok") {
          assert.notEqual(
            after.tokenRevision,
            before.tokenRevision,
            "an allowed Codex refresh must advance the document revision",
          );
          rotation = "observed";
        }
      }
    }

    process.stdout.write(`${JSON.stringify({
      result: "pass",
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
      credentialStayedUsable,
      credentialStayedNonTerminal,
    })}\n`);
  } finally {
    await server?.close().catch(() => undefined);
    await composition?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

interface LaneProbeResult {
  readonly status: number;
  readonly outcome: "completed" | "rejected" | "error";
  readonly detail?: string;
}

function summarizeStream(status: number, body: string): LaneProbeResult {
  // The Native lane streams Responses SSE; the Anthropic lane answers with an
  // Anthropic Messages object (or SSE when the client asks for a stream).
  const completed =
    /response\.completed/u.test(body) ||
    /message_stop/u.test(body) ||
    /"type"\s*:\s*"message"/u.test(body) ||
    /"stop_reason"\s*:\s*"(end_turn|max_tokens|stop_sequence|tool_use)"/u.test(body);
  if (status === 200 && completed) {
    return Object.freeze({ status, outcome: "completed" as const });
  }
  if (status >= 400 && status < 500) {
    return Object.freeze({
      status,
      outcome: "rejected" as const,
      detail: boundedDetail(body),
    });
  }
  return Object.freeze({
    status,
    outcome: "error" as const,
    detail: boundedDetail(body),
  });
}

function boundedDetail(body: string): string {
  return body.replace(/\s+/gu, " ").slice(0, 240);
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
  return summarizeStream(response.status, await response.text());
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
  return summarizeStream(response.status, await response.text());
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `openai-codex provider online suite failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
