import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const STATE_SCHEMA = "luckytoken-codex-integration-v1" as const;
const BASE_URL_MARKER = "# LuckyToken managed: openai_base_url";
const CATALOG_MARKER = "# LuckyToken managed: model_catalog_json";

export type CodexIntegrationObservedState =
  | "native"
  | "managed"
  | "drifted"
  | "conflict"
  | "unavailable";

export interface CodexCatalogBuildResult {
  readonly content: string;
  readonly modelCount: number;
  readonly warnings: readonly string[];
}

export interface CodexIntegrationProjection {
  readonly desiredEnabled: boolean;
  readonly observedState: CodexIntegrationObservedState;
  readonly codexHome: string;
  readonly configPath: string;
  readonly catalogPath: string;
  readonly endpoint?: string;
  readonly modelCount?: number;
  readonly warnings: readonly string[];
  readonly restartRequired: boolean;
  readonly message?: string;
}

export interface CodexIntegrationAuthority {
  query(): Promise<CodexIntegrationProjection>;
  setEnabled(enabled: boolean): Promise<CodexIntegrationProjection>;
  syncCatalog(): Promise<CodexIntegrationProjection>;
}

export interface CodexIntegrationAuthorityOptions {
  readonly codexHome: string;
  readonly stateDirectory: string;
  readonly endpoint: () => string | undefined;
  readonly localAuthAvailable: () => Promise<boolean>;
  readonly buildCatalog: () => Promise<CodexCatalogBuildResult>;
}

interface IntegrationState {
  readonly schemaVersion: typeof STATE_SCHEMA;
  readonly desiredEnabled: boolean;
  readonly originalConfigBase64?: string;
  readonly injectedConfigSha256?: string;
  readonly managedBaseUrl?: string;
  readonly managedCatalogPath?: string;
  readonly modelCount?: number;
  readonly warnings?: readonly string[];
}

interface RootRouting {
  readonly modelProvider?: string;
  readonly baseUrl?: string;
  readonly catalogPath?: string;
  readonly baseUrlOwned: boolean;
  readonly catalogOwned: boolean;
  readonly duplicate: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function parseTomlString(value: string): string | undefined {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return undefined;
}

function inspectRouting(content: string): RootRouting {
  const lines = content.split(/\r?\n/u);
  const rootEnd = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = rootEnd < 0 ? lines.length : rootEnd;
  const hits = new Map<string, Array<{ index: number; value?: string }>>();
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] as string;
    if (/^\s*#/u.test(line)) continue;
    const match = line.match(
      /^\s*(model_provider|openai_base_url|model_catalog_json)\s*=\s*(.+?)\s*(?:#.*)?$/u,
    );
    if (match === null) continue;
    const key = match[1] as string;
    const parsed = parseTomlString(match[2] as string);
    const list = hits.get(key) ?? [];
    list.push({ index, ...(parsed === undefined ? {} : { value: parsed }) });
    hits.set(key, list);
  }
  const model = hits.get("model_provider") ?? [];
  const base = hits.get("openai_base_url") ?? [];
  const catalog = hits.get("model_catalog_json") ?? [];
  const baseHit = base[0];
  const catalogHit = catalog[0];
  return {
    ...(model[0]?.value === undefined ? {} : { modelProvider: model[0].value }),
    ...(baseHit?.value === undefined ? {} : { baseUrl: baseHit.value }),
    ...(catalogHit?.value === undefined ? {} : { catalogPath: catalogHit.value }),
    baseUrlOwned:
      baseHit !== undefined &&
      baseHit.index > 0 &&
      (lines[baseHit.index - 1] as string).trim() === BASE_URL_MARKER,
    catalogOwned:
      catalogHit !== undefined &&
      catalogHit.index > 0 &&
      (lines[catalogHit.index - 1] as string).trim() === CATALOG_MARKER,
    duplicate: model.length > 1 || base.length > 1 || catalog.length > 1,
  };
}

function conflictMessage(
  content: string,
  state: IntegrationState,
): string | undefined {
  const routing = inspectRouting(content);
  if (routing.duplicate) return "Codex config.toml contains duplicate root routing keys.";
  if (routing.modelProvider !== undefined && routing.modelProvider !== "openai") {
    return `Codex config.toml selects an external model_provider (${routing.modelProvider}).`;
  }
  if (routing.baseUrl !== undefined) {
    const ours =
      state.desiredEnabled &&
      routing.baseUrlOwned &&
      state.managedBaseUrl === routing.baseUrl;
    if (!ours) return "Codex config.toml already owns openai_base_url.";
  }
  if (routing.catalogPath !== undefined) {
    const ours =
      state.desiredEnabled &&
      routing.catalogOwned &&
      state.managedCatalogPath === routing.catalogPath;
    if (!ours) return "Codex config.toml already owns model_catalog_json.";
  }
  return undefined;
}

function eol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function inject(content: string, baseUrl: string, catalogPath: string): string {
  const ending = eol(content);
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  let at = firstTable < 0 ? lines.length : firstTable;
  while (at > 0 && (lines[at - 1] as string).trim() === "") at -= 1;
  const block = [
    BASE_URL_MARKER,
    `openai_base_url = ${tomlString(baseUrl)}`,
    CATALOG_MARKER,
    `model_catalog_json = ${tomlString(catalogPath)}`,
  ];
  if (at > 0 && (lines[at - 1] as string).trim() !== "") block.unshift("");
  block.push("");
  lines.splice(at, 0, ...block);
  const normalized = lines.join("\n").replace(/^\n+/u, "");
  return ending === "\n" ? normalized : normalized.replace(/\n/gu, "\r\n");
}

function stripOwned(
  content: string,
  state: IntegrationState,
): { readonly content: string; readonly clean: boolean } {
  if (state.managedBaseUrl === undefined || state.managedCatalogPath === undefined) {
    return { content, clean: false };
  }
  const lines = content.replace(/\r\n/gu, "\n").split("\n");
  const pairs = [
    [BASE_URL_MARKER, `openai_base_url = ${tomlString(state.managedBaseUrl)}`],
    [CATALOG_MARKER, `model_catalog_json = ${tomlString(state.managedCatalogPath)}`],
  ] as const;
  let clean = true;
  for (const [marker, expected] of pairs) {
    const markerIndex = lines.findIndex((line) => line.trim() === marker);
    if (markerIndex < 0) continue;
    if ((lines[markerIndex + 1] as string | undefined)?.trim() !== expected) {
      clean = false;
      continue;
    }
    lines.splice(markerIndex, 2);
  }
  while (lines.length > 1 && (lines[0] as string).trim() === "") lines.shift();
  const ending = eol(content);
  const normalized = lines.join("\n").replace(/\n{3,}/gu, "\n\n");
  const output = ending === "\n" ? normalized : normalized.replace(/\n/gu, "\r\n");
  const residual = inspectRouting(output);
  if (residual.baseUrl !== undefined || residual.catalogPath !== undefined) {
    clean = false;
  }
  return { content: output, clean };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function emptyState(): IntegrationState {
  return { schemaVersion: STATE_SCHEMA, desiredEnabled: false };
}

async function readState(path: string): Promise<IntegrationState> {
  const raw = await readOptional(path);
  if (raw === undefined) return emptyState();
  try {
    const parsed = JSON.parse(raw) as IntegrationState;
    return parsed.schemaVersion === STATE_SCHEMA && typeof parsed.desiredEnabled === "boolean"
      ? parsed
      : emptyState();
  } catch {
    return emptyState();
  }
}

export function createCodexIntegrationAuthority(
  options: CodexIntegrationAuthorityOptions,
): CodexIntegrationAuthority {
  const configPath = join(options.codexHome, "config.toml");
  const statePath = join(options.stateDirectory, "integration-state.json");
  const catalogPath = join(options.stateDirectory, "model-catalog.json");
  const writeState = (state: IntegrationState) =>
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const project = async (
    state: IntegrationState,
    override: Partial<CodexIntegrationProjection> = {},
  ): Promise<CodexIntegrationProjection> => {
    const config = await readOptional(configPath);
    const endpoint = options.endpoint();
    let observedState: CodexIntegrationObservedState = "unavailable";
    let message: string | undefined;
    if (config === undefined) {
      message = "Codex config.toml was not found.";
    } else {
      const conflict = conflictMessage(config, state);
      const routing = inspectRouting(config);
      if (conflict !== undefined) {
        const managedResidue =
          state.managedBaseUrl !== undefined ||
          state.managedCatalogPath !== undefined ||
          state.injectedConfigSha256 !== undefined;
        observedState = state.desiredEnabled || managedResidue ? "drifted" : "conflict";
        message = conflict;
      } else if (
        state.desiredEnabled &&
        routing.baseUrlOwned &&
        routing.catalogOwned &&
        routing.baseUrl === state.managedBaseUrl &&
        routing.catalogPath === state.managedCatalogPath
      ) {
        observedState = "managed";
      } else {
        observedState = "native";
      }
    }
    return Object.freeze({
      desiredEnabled: state.desiredEnabled,
      observedState,
      codexHome: options.codexHome,
      configPath,
      catalogPath,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(state.modelCount === undefined ? {} : { modelCount: state.modelCount }),
      warnings: Object.freeze([...(state.warnings ?? [])]),
      restartRequired: false,
      ...(message === undefined ? {} : { message }),
      ...override,
    });
  };

  const enable = async (): Promise<CodexIntegrationProjection> => {
    const state = await readState(statePath);
    const config = await readOptional(configPath);
    if (config === undefined) {
      return project(state, { observedState: "unavailable", message: "Codex config.toml was not found." });
    }
    const endpoint = options.endpoint();
    if (endpoint === undefined) {
      return project(state, { observedState: "unavailable", message: "LuckyToken Data Plane endpoint is unavailable." });
    }
    const conflict = conflictMessage(config, state);
    if (conflict !== undefined) {
      return project(state, { observedState: "conflict", message: conflict });
    }
    if (!(await options.localAuthAvailable())) {
      return project(state, {
        message: "Local Codex authentication is unavailable; LuckyToken did not change Codex configuration.",
      });
    }
    if (state.desiredEnabled && inspectRouting(config).baseUrlOwned && inspectRouting(config).catalogOwned) {
      return project(state);
    }

    const catalog = await options.buildCatalog();
    const desired: IntegrationState = {
      schemaVersion: STATE_SCHEMA,
      desiredEnabled: true,
      originalConfigBase64: Buffer.from(config, "utf8").toString("base64"),
      managedBaseUrl: endpoint,
      managedCatalogPath: catalogPath,
      modelCount: catalog.modelCount,
      warnings: catalog.warnings,
    };
    await writeState(desired); // intent first
    await atomicWrite(catalogPath, catalog.content);

    const current = await readOptional(configPath);
    if (current !== config) {
      return project(desired, {
        observedState: "drifted",
        message: "Codex config.toml changed while LuckyToken was applying the integration.",
      });
    }
    const injected = inject(config, endpoint, catalogPath);
    await atomicWrite(configPath, injected);
    const committed: IntegrationState = {
      ...desired,
      injectedConfigSha256: sha256(injected),
    };
    await writeState(committed);
    return project(committed, { restartRequired: true });
  };

  const disable = async (): Promise<CodexIntegrationProjection> => {
    const state = await readState(statePath);
    const ownsCodexArtifacts =
      state.managedBaseUrl !== undefined ||
      state.managedCatalogPath !== undefined ||
      state.injectedConfigSha256 !== undefined ||
      state.originalConfigBase64 !== undefined;
    if (!state.desiredEnabled && !ownsCodexArtifacts) return project(state);
    const off: IntegrationState = { ...state, desiredEnabled: false };
    await writeState(off); // intent first
    const current = await readOptional(configPath);
    if (current === undefined) {
      return project(off, { observedState: "unavailable", message: "Codex config.toml was not found." });
    }

    if (
      state.injectedConfigSha256 !== undefined &&
      state.originalConfigBase64 !== undefined &&
      sha256(current) === state.injectedConfigSha256
    ) {
      await atomicWrite(
        configPath,
        Buffer.from(state.originalConfigBase64, "base64").toString("utf8"),
      );
      await rm(catalogPath, { force: true });
      const clean = emptyState();
      await writeState(clean);
      return project(clean, { restartRequired: true });
    }

    const stripped = stripOwned(current, state);
    if (stripped.content !== current) await atomicWrite(configPath, stripped.content);
    if (stripped.clean) {
      await rm(catalogPath, { force: true });
      const clean = emptyState();
      await writeState(clean);
      return project(clean, { restartRequired: true });
    }
    return project(off, {
      observedState: "drifted",
      restartRequired: true,
      message: "Codex config changed after LuckyToken configured it; user-owned routing edits were preserved.",
    });
  };

  return Object.freeze({
    query: async () => project(await readState(statePath)),
    setEnabled: async (enabled: boolean) => (enabled ? enable() : disable()),
    syncCatalog: async () => {
      const state = await readState(statePath);
      if (!state.desiredEnabled) {
        return project(state, { message: "Codex integration is disabled; catalog was not changed." });
      }
      const catalog = await options.buildCatalog();
      await atomicWrite(catalogPath, catalog.content);
      const next: IntegrationState = {
        ...state,
        modelCount: catalog.modelCount,
        warnings: catalog.warnings,
      };
      await writeState(next);
      return project(next, { restartRequired: true });
    },
  });
}
