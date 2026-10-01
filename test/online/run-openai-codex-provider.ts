import assert from "node:assert/strict";
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
import { createConfiguredTokenDataPlane } from "../support/configured-data-plane.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEDICATED_CODEX_AUTH_HOME_ENV = "TOKEN_CODEX_TEST_AUTH_HOME";
const PROVIDER_ID = "openai-codex";

/**
 * Dedicated `openai-codex` online suite.
 *
 * Requires a dedicated test login supplied through
 * `TOKEN_CODEX_TEST_AUTH_HOME`. The suite never reads or copies the user's
 * real `~/.codex/auth.json`; when the dedicated login is unavailable it
 * records a skip instead of mocking anything.
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
  if (dedicatedHome === undefined || dedicatedHome.length === 0) {
    process.stdout.write(`${JSON.stringify({
      result: "skip",
      reason: "dedicated_codex_test_login_unavailable",
      env: DEDICATED_CODEX_AUTH_HOME_ENV,
    })}\n`);
    return;
  }
  const codexHome = resolve(dedicatedHome);
  const authPath = codexExternalAuthPath(codexHome);
  const parsed = parseCodexExternalAuth(await readFile(authPath, "utf8"));
  if (parsed.state !== "ok") {
    throw new Error(`Dedicated Codex login is not a ChatGPT document: ${parsed.reason}`);
  }
  // The external credential source, the Codex-delegated refresh, and the
  // Codex CLI all observe this dedicated test home.
  process.env.CODEX_HOME = codexHome;

  const root = await mkdtemp(join(tmpdir(), "Token-openai-codex-online-"));
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
    const composition = await createConfiguredTokenDataPlane({
      config,
      fetch: globalThis.fetch,
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

    const piIds = new Set(
      (builtinProviders().find((builtin) => builtin.id === PROVIDER_ID)?.getModels() ?? [])
        .map((model) => model.id),
    );
    const nativeIds = await nativeListableIds(codexHome);
    assert.ok(nativeIds.length > 0, "native catalog must expose at least one listable model");
    const servedIds = new Set(
      composition.catalog.models.getModels(PROVIDER_ID).map((model) => model.id),
    );
    const missingNative = nativeIds.filter((id) => !piIds.has(id));
    assert.ok(
      missingNative.length > 0,
      "the dedicated host must expose at least one Pi-missing native model",
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
    await usage.close();
    assert.notEqual(
      usageResult.refresh.outcome,
      "unsupported",
      "an external Codex login must be usage-eligible",
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
      connected: true,
      nativeListable: nativeIds.length,
      piMissingNative: missingNative,
      servedModelCount: servedIds.size,
      usage: usageResult.refresh,
      rotation,
    })}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `openai-codex provider online suite failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
