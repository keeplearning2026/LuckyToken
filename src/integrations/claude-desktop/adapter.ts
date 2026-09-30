import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";
import lockfile from "proper-lockfile";

import type {
  AgentIntegrationAdapter,
  AgentIntegrationEffect,
  AgentInjectionScope,
} from "../agents/contract.js";
import type { AgentInjectionSnapshot } from "../agents/snapshot.js";
import { projectClaudeDesktopModels } from "./aliases.js";
import { CLAUDE_DESKTOP_PROFILE_ID, type ClaudeDesktopPaths } from "./paths.js";

const STATE_SCHEMA = "Token-claude-desktop-integration-v1";
const LOCAL_KEY = "token-local";

interface PreviousValue {
  readonly present: boolean;
  readonly value?: unknown;
}

interface RestoreSnapshot {
  readonly standardMode: PreviousValue;
  readonly threePartyMode: PreviousValue;
  readonly appliedId: PreviousValue;
}

interface StoredState extends RestoreSnapshot {
  readonly schemaVersion: typeof STATE_SCHEMA;
  readonly entriesPresent: boolean;
  readonly createdStandard: boolean;
  readonly createdThreeParty: boolean;
  readonly createdMetadata: boolean;
}

export interface CreateClaudeDesktopIntegrationAdapterOptions {
  readonly paths: ClaudeDesktopPaths;
  readonly stateDirectory: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function replaceIfUnchanged(path: string, before: string | undefined, after: string): Promise<boolean> {
  if (before === after) return false;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, after, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    if ((await readOptional(path)) !== before) {
      throw new Error(`${path} changed during Claude Desktop integration update.`);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return true;
}

function parseObject(raw: string | undefined, label: string): { raw: string; value: Record<string, unknown> } {
  const source = raw ?? "{}\n";
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return { raw: source, value };
}

function formatting(raw: string): FormattingOptions {
  const indent = /\r?\n([ \t]+)\S/u.exec(raw)?.[1] ?? "  ";
  return {
    insertSpaces: !indent.startsWith("\t"),
    tabSize: indent.startsWith("\t") ? 1 : indent.length,
    eol: raw.includes("\r\n") ? "\r\n" : "\n",
  };
}

function setPath(raw: string, path: readonly (string | number)[], value: unknown): string {
  return applyEdits(raw, modify(raw, [...path], value, { formattingOptions: formatting(raw) }));
}

function previous(object: Record<string, unknown>, key: string): PreviousValue {
  return Object.hasOwn(object, key)
    ? { present: true, value: object[key] }
    : { present: false };
}

function restorePath(raw: string, path: readonly (string | number)[], value: PreviousValue): string {
  return setPath(raw, path, value.present ? value.value : undefined);
}

function effect(
  observedState: AgentIntegrationEffect["observedState"],
  modelCount: number,
  warnings: readonly string[],
  changed: boolean,
  message?: string,
): AgentIntegrationEffect {
  return Object.freeze({
    observedState,
    modelCount,
    warnings: Object.freeze([...warnings]),
    changed,
    ...(message === undefined ? {} : { message }),
  });
}

function profile(snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope): {
  readonly content: string;
  readonly count: number;
} {
  const projection = projectClaudeDesktopModels(snapshot[scope]);
  const content = `${JSON.stringify({
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: snapshot.endpoint.origin,
    inferenceGatewayApiKey: LOCAL_KEY,
    inferenceGatewayAuthScheme: "bearer",
    modelDiscoveryEnabled: false,
    inferenceModels: projection.inferenceModels,
  }, null, 2)}\n`;
  return { content, count: projection.inferenceModels.length };
}

function readState(raw: string | undefined): StoredState | undefined {
  if (raw === undefined) return undefined;
  const state = JSON.parse(raw) as unknown;
  if (!isRecord(state) || state.schemaVersion !== STATE_SCHEMA ||
    !isRecord(state.standardMode) || typeof state.standardMode.present !== "boolean" ||
    !isRecord(state.threePartyMode) || typeof state.threePartyMode.present !== "boolean" ||
    !isRecord(state.appliedId) || typeof state.appliedId.present !== "boolean" ||
    typeof state.entriesPresent !== "boolean" ||
    typeof state.createdStandard !== "boolean" ||
    typeof state.createdThreeParty !== "boolean" ||
    typeof state.createdMetadata !== "boolean") {
    throw new Error("Claude Desktop integration state is invalid.");
  }
  return state as unknown as StoredState;
}

export function createClaudeDesktopIntegrationAdapter(
  options: CreateClaudeDesktopIntegrationAdapterOptions,
): AgentIntegrationAdapter {
  const { paths } = options;
  const statePath = join(options.stateDirectory, "claude-desktop-integration.json");
  const lockTarget = join(options.stateDirectory, "claude-desktop-integration.lock");
  let operationQueue = Promise.resolve();

  const withLock = async <T>(work: () => Promise<T>): Promise<T> => {
    await mkdir(options.stateDirectory, { recursive: true });
    await writeFile(lockTarget, "", { flag: "a", encoding: "utf8", mode: 0o600 });
    const release = await lockfile.lock(lockTarget, {
      realpath: false,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 250 },
      stale: 30_000,
    });
    try {
      return await work();
    } finally {
      await release().catch(() => undefined);
    }
  };

  const restoreLocked = async (): Promise<AgentIntegrationEffect> => {
    const state = readState(await readOptional(statePath));
    if (state === undefined) {
      return effect("native", 0, [], false);
    }
    let standard: ReturnType<typeof parseObject>;
    let threeParty: ReturnType<typeof parseObject>;
    let metadata: ReturnType<typeof parseObject>;
    const originalStandard = await readOptional(paths.standardConfig);
    const originalThreeParty = await readOptional(paths.threePartyConfig);
    const originalMetadata = await readOptional(paths.metadata);
    try {
      standard = parseObject(originalStandard, "Claude Desktop standard config");
      threeParty = parseObject(originalThreeParty, "Claude Desktop 3P config");
      metadata = parseObject(originalMetadata, "Claude Desktop config metadata");
      if (metadata.value.entries !== undefined && !Array.isArray(metadata.value.entries)) {
        throw new Error("Claude Desktop config metadata entries must be an array.");
      }
    } catch (error) {
      return effect("conflict", 0, [], false, error instanceof Error ? error.message : String(error));
    }
    const wasApplied = metadata.value.appliedId === CLAUDE_DESKTOP_PROFILE_ID;
    let nextMetadata = metadata.raw;
    const entries = (metadata.value.entries ?? []) as unknown[];
    const remaining = entries.filter((entry) => !isRecord(entry) || entry.id !== CLAUDE_DESKTOP_PROFILE_ID);
    if (remaining.length !== entries.length) {
      nextMetadata = setPath(nextMetadata, ["entries"],
        state.entriesPresent ? remaining : remaining.length > 0 ? remaining : undefined);
    }
    if (wasApplied) nextMetadata = restorePath(nextMetadata, ["appliedId"], state.appliedId);
    let nextStandard = standard.raw;
    let nextThreeParty = threeParty.raw;
    // A different selected profile is one combined user choice: its 3p modes
    // must stay in place even if Token originally enabled 3p.
    if (wasApplied && standard.value.deploymentMode === "3p") {
      nextStandard = restorePath(nextStandard, ["deploymentMode"], state.standardMode);
    }
    if (wasApplied && threeParty.value.deploymentMode === "3p") {
      nextThreeParty = restorePath(nextThreeParty, ["deploymentMode"], state.threePartyMode);
    }
    let changed = false;
    try {
      // Release the selected profile before removing its file.
      if (originalMetadata !== undefined && nextMetadata !== metadata.raw) {
        changed = await replaceIfUnchanged(paths.metadata, originalMetadata, nextMetadata) || changed;
      }
      if (originalStandard !== undefined && nextStandard !== standard.raw) {
        changed = await replaceIfUnchanged(paths.standardConfig, originalStandard, nextStandard) || changed;
      }
      if (originalThreeParty !== undefined && nextThreeParty !== threeParty.raw) {
        changed = await replaceIfUnchanged(paths.threePartyConfig, originalThreeParty, nextThreeParty) || changed;
      }
      const currentProfile = await readOptional(paths.tokenProfile);
      if (currentProfile !== undefined) {
        await rm(paths.tokenProfile);
        changed = true;
      }
      for (const [path, created] of [
        [paths.metadata, state.createdMetadata],
        [paths.standardConfig, state.createdStandard],
        [paths.threePartyConfig, state.createdThreeParty],
      ] as const) {
        if (!created) continue;
        const raw = await readOptional(path);
        if (raw !== undefined && Object.keys(parseObject(raw, path).value).length === 0) {
          await rm(path);
          changed = true;
        }
      }
      await rm(statePath, { force: true });
      return effect("native", 0, [], changed,
        wasApplied ? "Restart Claude Desktop to apply the restored configuration."
          : "Claude Desktop selected another profile; its selected profile was preserved. Restart Claude Desktop to apply the restored configuration.");
    } catch (error) {
      return effect("conflict", 0, [], changed, error instanceof Error ? error.message : String(error));
    }
  };

  const injectLocked = async (
    snapshot: AgentInjectionSnapshot,
    scope: AgentInjectionScope,
  ): Promise<AgentIntegrationEffect> => {
    const generated = profile(snapshot, scope);
    if (generated.count === 0) {
      const restored = await restoreLocked();
      return effect(restored.observedState, 0, snapshot.warnings, restored.changed,
        restored.message ?? `Claude Desktop ${scope === "favorite" ? "Favorite" : "All"} scope has no injectable models.`);
    }
    const originalState = await readOptional(statePath);
    const state = readState(originalState);
    const originalStandard = await readOptional(paths.standardConfig);
    const originalThreeParty = await readOptional(paths.threePartyConfig);
    const originalMetadata = await readOptional(paths.metadata);
    const originalProfile = await readOptional(paths.tokenProfile);
    let standard: ReturnType<typeof parseObject>;
    let threeParty: ReturnType<typeof parseObject>;
    let metadata: ReturnType<typeof parseObject>;
    try {
      standard = parseObject(originalStandard, "Claude Desktop standard config");
      threeParty = parseObject(originalThreeParty, "Claude Desktop 3P config");
      metadata = parseObject(originalMetadata, "Claude Desktop config metadata");
      if (metadata.value.entries !== undefined && !Array.isArray(metadata.value.entries)) {
        throw new Error("Claude Desktop config metadata entries must be an array.");
      }
      if (state === undefined && metadata.value.appliedId === CLAUDE_DESKTOP_PROFILE_ID) {
        return effect("conflict", 0, snapshot.warnings, false,
          "Claude Desktop selects Token's profile, but its restore state is missing.");
      }
    } catch (error) {
      return effect("conflict", 0, snapshot.warnings, false, error instanceof Error ? error.message : String(error));
    }
    const first = state === undefined;
    const selectedAnotherProfile = metadata.value.appliedId !== CLAUDE_DESKTOP_PROFILE_ID;
    const captureSelection = first || selectedAnotherProfile;
    // Profile selection is a combined state. Capture both modes even when
    // they still equal Token's desired 3p value.
    const restoreSnapshot: RestoreSnapshot = captureSelection ? {
      appliedId: previous(metadata.value, "appliedId"),
      standardMode: previous(standard.value, "deploymentMode"),
      threePartyMode: previous(threeParty.value, "deploymentMode"),
    } : {
      appliedId: state!.appliedId,
      standardMode: standard.value.deploymentMode !== "3p"
        ? previous(standard.value, "deploymentMode") : state!.standardMode,
      threePartyMode: threeParty.value.deploymentMode !== "3p"
        ? previous(threeParty.value, "deploymentMode") : state!.threePartyMode,
    };
    const nextState: StoredState = {
      schemaVersion: STATE_SCHEMA,
      standardMode: restoreSnapshot.standardMode,
      threePartyMode: restoreSnapshot.threePartyMode,
      appliedId: restoreSnapshot.appliedId,
      entriesPresent: state?.entriesPresent ?? Object.hasOwn(metadata.value, "entries"),
      createdStandard: state?.createdStandard ?? originalStandard === undefined,
      createdThreeParty: state?.createdThreeParty ?? originalThreeParty === undefined,
      createdMetadata: state?.createdMetadata ?? originalMetadata === undefined,
    };
    const nextStateRaw = `${JSON.stringify(nextState, null, 2)}\n`;
    const stateChanged = originalState !== nextStateRaw;
    const entries = (metadata.value.entries ?? []) as unknown[];
    const retained = entries.filter((entry) => !isRecord(entry) || entry.id !== CLAUDE_DESKTOP_PROFILE_ID);
    const tokenEntries = entries.filter((entry) => isRecord(entry) && entry.id === CLAUDE_DESKTOP_PROFILE_ID);
    const canonicalEntry = tokenEntries.length === 1 && isRecord(tokenEntries[0]) &&
      tokenEntries[0].name === "Token" && Object.keys(tokenEntries[0]).length === 2;
    let nextMetadata = canonicalEntry ? metadata.raw
      : setPath(metadata.raw, ["entries"], [...retained, { id: CLAUDE_DESKTOP_PROFILE_ID, name: "Token" }]);
    if (selectedAnotherProfile) nextMetadata = setPath(nextMetadata, ["appliedId"], CLAUDE_DESKTOP_PROFILE_ID);
    const nextStandard = standard.value.deploymentMode === "3p"
      ? standard.raw : setPath(standard.raw, ["deploymentMode"], "3p");
    const nextThreeParty = threeParty.value.deploymentMode === "3p"
      ? threeParty.raw : setPath(threeParty.raw, ["deploymentMode"], "3p");
    const written: { path: string; before: string | undefined; after: string }[] = [];
    let statePersisted = false;
    try {
      if (stateChanged) {
        await replaceIfUnchanged(statePath, originalState, nextStateRaw);
        statePersisted = true;
      }
      for (const [path, before, after] of [
        [paths.tokenProfile, originalProfile, generated.content],
        [paths.metadata, originalMetadata, nextMetadata],
        [paths.threePartyConfig, originalThreeParty, nextThreeParty],
        [paths.standardConfig, originalStandard, nextStandard],
      ] as const) {
        if (await replaceIfUnchanged(path, before, after)) written.push({ path, before, after });
      }
      return effect("managed", generated.count, snapshot.warnings, written.length > 0,
        "Fully quit and reopen Claude Desktop to apply the configuration.");
    } catch (error) {
      let rollbackFailed = false;
      for (const step of written.reverse()) {
        try {
          if ((await readOptional(step.path)) !== step.after) {
            rollbackFailed = true;
            continue;
          }
          if (step.before === undefined) await rm(step.path);
          else await replaceIfUnchanged(step.path, step.after, step.before);
        } catch {
          rollbackFailed = true;
        }
      }
      if (statePersisted && !rollbackFailed) {
        try {
          if ((await readOptional(statePath)) !== nextStateRaw) {
            throw new Error("Claude Desktop restore state changed during rollback.");
          }
          if (originalState === undefined) await rm(statePath);
          else await replaceIfUnchanged(statePath, nextStateRaw, originalState);
        } catch {
          rollbackFailed = true;
        }
      }
      return effect("unavailable", 0, snapshot.warnings, rollbackFailed,
        `Claude Desktop injection failed${rollbackFailed ? " and rollback needs another attempt" : ""}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = operationQueue.then(() => withLock(work));
    operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return Object.freeze({
    id: "claude-desktop",
    projectionFingerprint: async (snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) =>
      createHash("sha256").update(profile(snapshot, scope).content).digest("hex"),
    inject: (snapshot: AgentInjectionSnapshot, scope: AgentInjectionScope) =>
      enqueue(() => injectLocked(snapshot, scope)),
    restore: () => enqueue(restoreLocked),
  });
}
