import type {
  AliasCommandResult,
  AliasFileError,
  AliasStatusProjection,
  AliasValidationErrorProjection,
  ApplicationOwnership,
  CatalogCommandResult,
  CatalogModelAvailability,
  CatalogModelProjection,
  CatalogProviderProjection,
  CatalogProviderState,
  CatalogRefreshErrorProjection,
  CatalogRefreshReportProjection,
  CatalogSnapshotProjection,
  CatalogStatusProjection,
  CredentialCommand,
  CredentialCommandResult,
  CredentialFileError,
  CredentialImportApplyEntryResult,
  CredentialImportEntryPreview,
  CredentialProjection,
  EffectiveCatalogCompositionError,
  EffectiveCatalogProjection,
  EffectiveModelLayer,
  EffectiveModelProjection,
  EffectiveProviderLayer,
  EffectiveProviderProjection,
  ModelsCommandResult,
  ModelsFileError,
  ModelsProjection,
  ProviderAuthStatus,
  RegisteredSetting,
  StatusSnapshot,
} from "@luckytoken/application-control-plane/control-plane";

export interface ConnectedControlPlaneBridgePayload extends Readonly<
  Record<string, unknown>
> {
  readonly revision: number;
  readonly connection: "connected";
  readonly applicationVersion: string;
  readonly contractVersion: 1;
  readonly snapshot: StatusSnapshot & Readonly<Record<string, unknown>>;
  /** Full models.json catalog result from a models command (Ticket 08). */
  readonly models?: ModelsCommandResult;
}

export interface ConnectedControlPlaneState extends StatusSnapshot {
  readonly revision: number;
  readonly kind: "connected";
  readonly applicationVersion: string;
  readonly contractVersion: 1;
  /** Latest full models.json catalog result (raw editor content, parsed
   *  providers, revision, errors); present after a models command. */
  readonly modelsResult?: ModelsCommandResult;
  /** Sanitized models.json projection from the status snapshot (Ticket 08). */
  readonly modelsProjection?: ModelsProjection;
  /** Sanitized auth.json credential projection from the status snapshot
   *  (Ticket 12): file facts plus bounded per-Provider auth status. */
  readonly credentialsProjection?: CredentialProjection;
  /** Sanitized catalog lifecycle projection from the status snapshot
   *  (Ticket 11): version, refreshing flag, failed Provider ids. */
  readonly catalogStatus?: CatalogStatusProjection;
  /** Sanitized model-aliases.json projection from the status snapshot
   *  (Ticket 14): revision, file facts, defaults version. */
  readonly aliasesProjection?: AliasStatusProjection;
}
/** Registered settings allowlist projected into renderer state. Only fields
 *  registered in the backend catalog reach the renderer; unregistered keys,
 *  ambient internal variables, and secrets never appear. */
export type RendererRegisteredSetting = RegisteredSetting;

export interface VersionMismatchBridgePayload extends Readonly<
  Record<string, unknown>
> {
  readonly revision: number;
  readonly connection: "version_mismatch";
  readonly requestedVersion: number;
  readonly supportedVersions: readonly number[];
}

export type ControlPlaneUnavailableReason =
  | "descriptor_missing"
  | "descriptor_invalid"
  | "pipe_unavailable"
  | "protocol_error";

export interface UnavailableBridgePayload extends Readonly<
  Record<string, unknown>
> {
  readonly revision: number;
  readonly connection: "unavailable";
  readonly reason: ControlPlaneUnavailableReason;
}

export interface DisconnectedBridgePayload extends Readonly<
  Record<string, unknown>
> {
  readonly revision: number;
  readonly connection: "disconnected";
  readonly reason: "transport_lost";
}

export type ControlPlaneBridgePayload =
  | ConnectedControlPlaneBridgePayload
  | VersionMismatchBridgePayload
  | UnavailableBridgePayload
  | DisconnectedBridgePayload;

export interface ControlPlaneErrorState {
  readonly revision: number;
  readonly kind: "error";
  readonly code:
    "version_mismatch" | ControlPlaneUnavailableReason | "transport_lost";
  readonly title: string;
  readonly detail: string;
  readonly action: string;
}

export type ControlPlaneState =
  ConnectedControlPlaneState | ControlPlaneErrorState;

function decodeRendererSetting(
  value: unknown,
): RendererRegisteredSetting | undefined {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    (value.type !== "boolean" &&
      value.type !== "number" &&
      value.type !== "string") ||
    (typeof value.default !== "boolean" &&
      typeof value.default !== "number" &&
      typeof value.default !== "string") ||
    (value.sensitivity !== "public" && value.sensitivity !== "secret") ||
    (value.applyMode !== "hot-apply" &&
      value.applyMode !== "restart-required") ||
    (typeof value.value !== "boolean" &&
      typeof value.value !== "number" &&
      typeof value.value !== "string")
  ) {
    return undefined;
  }
  const effective =
    typeof value.effective === "boolean" ||
    typeof value.effective === "number" ||
    typeof value.effective === "string"
      ? value.effective
      : undefined;
  if (
    (value.effective !== undefined && effective === undefined) ||
    (value.applyMode === "hot-apply" && value.effective !== undefined) ||
    (value.applyMode === "restart-required" && effective === undefined)
  ) {
    return undefined;
  }
  return Object.freeze({
    key: value.key,
    type: value.type,
    default: value.default,
    validation: value.validation,
    sensitivity: value.sensitivity,
    applyMode: value.applyMode,
    value: value.value,
    ...(effective === undefined ? {} : { effective }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const effectiveModelLayers: ReadonlySet<string> = new Set([
  "builtin",
  "user",
  "upserted",
  "overridden",
]);

const effectiveProviderLayers: ReadonlySet<string> = new Set([
  "builtin",
  "user",
  "overlaid",
]);

function decodeThinkingLevelMap(
  value: unknown,
): Readonly<Record<string, string | null>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" && entry !== null) return undefined;
    result[key] = entry;
  }
  return Object.freeze(result);
}

function decodeEffectiveCatalog(
  value: unknown,
): EffectiveCatalogProjection | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "luckytoken-effective-catalog-v1" ||
    !isRecord(value.baseline) ||
    typeof value.baseline.package !== "string" ||
    value.baseline.package.length === 0 ||
    typeof value.baseline.version !== "string" ||
    value.baseline.version.length === 0 ||
    typeof value.baseline.schema !== "string" ||
    value.baseline.schema.length === 0 ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.compositionErrors)
  ) {
    return undefined;
  }
  const providers: EffectiveProviderProjection[] = [];
  for (const rawProvider of value.providers) {
    const provider = decodeEffectiveProvider(rawProvider);
    if (provider === undefined) return undefined;
    providers.push(provider);
  }
  const compositionErrors: EffectiveCatalogCompositionError[] = [];
  for (const entry of value.compositionErrors) {
    if (
      !isRecord(entry) ||
      typeof entry.providerId !== "string" ||
      entry.providerId.length === 0 ||
      typeof entry.message !== "string" ||
      entry.message.length === 0
    ) {
      return undefined;
    }
    compositionErrors.push(
      Object.freeze({ providerId: entry.providerId, message: entry.message }),
    );
  }
  return Object.freeze({
    schemaVersion: "luckytoken-effective-catalog-v1",
    baseline: Object.freeze({
      package: value.baseline.package as "@earendil-works/pi-coding-agent",
      version: value.baseline.version as "0.84.1",
      schema: value.baseline
        .schema as "pi-coding-agent-0.84.1-models-json-schema",
    }),
    providers: Object.freeze(providers),
    compositionErrors: Object.freeze(compositionErrors),
  });
}

function decodeEffectiveProvider(
  value: unknown,
): EffectiveProviderProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.layer !== "string" ||
    !effectiveProviderLayers.has(value.layer) ||
    !Array.isArray(value.models)
  ) {
    return undefined;
  }
  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") {
    return undefined;
  }
  const models: EffectiveModelProjection[] = [];
  for (const rawModel of value.models) {
    const model = decodeEffectiveModel(rawModel);
    if (model === undefined) return undefined;
    models.push(model);
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    ...(value.baseUrl === undefined ? {} : { baseUrl: value.baseUrl }),
    layer: value.layer as EffectiveProviderLayer,
    models: Object.freeze(models),
  });
}

function decodeEffectiveModel(
  value: unknown,
): EffectiveModelProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.api !== "string" ||
    value.api.length === 0 ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.baseUrl !== "string" ||
    typeof value.reasoning !== "boolean" ||
    typeof value.contextWindow !== "number" ||
    typeof value.maxTokens !== "number" ||
    typeof value.layer !== "string" ||
    !effectiveModelLayers.has(value.layer)
  ) {
    return undefined;
  }
  const input = value.input;
  if (
    !Array.isArray(input) ||
    input.some((entry) => entry !== "text" && entry !== "image")
  ) {
    return undefined;
  }
  const cost = value.cost;
  if (
    !isRecord(cost) ||
    typeof cost.input !== "number" ||
    typeof cost.output !== "number" ||
    typeof cost.cacheRead !== "number" ||
    typeof cost.cacheWrite !== "number" ||
    (cost.tiers !== undefined && !Array.isArray(cost.tiers))
  ) {
    return undefined;
  }
  const overriddenFields = value.overriddenFields;
  if (
    overriddenFields !== undefined &&
    (!Array.isArray(overriddenFields) ||
      overriddenFields.some((entry) => typeof entry !== "string"))
  ) {
    return undefined;
  }
  if (value.layer !== "overridden" && overriddenFields !== undefined) {
    return undefined;
  }
  const thinkingLevelMap = decodeThinkingLevelMap(value.thinkingLevelMap);
  if (value.thinkingLevelMap !== undefined && thinkingLevelMap === undefined) {
    return undefined;
  }
  if (value.compat !== undefined && !isRecord(value.compat)) {
    return undefined;
  }
  return Object.freeze({
    id: value.id,
    name: value.name,
    api: value.api,
    provider: value.provider,
    baseUrl: value.baseUrl,
    reasoning: value.reasoning,
    input: Object.freeze([...input]),
    cost: Object.freeze({
      input: cost.input,
      output: cost.output,
      cacheRead: cost.cacheRead,
      cacheWrite: cost.cacheWrite,
      ...(cost.tiers === undefined
        ? {}
        : { tiers: Object.freeze([...cost.tiers]) }),
    }),
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens,
    layer: value.layer as EffectiveModelLayer,
    ...(overriddenFields === undefined
      ? {}
      : { overriddenFields: Object.freeze([...overriddenFields]) }),
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(value.compat === undefined ? {} : { compat: value.compat }),
  });
}

const modelsErrorKinds: ReadonlySet<string> = new Set([
  "parse",
  "schema",
  "load",
  "storage",
]);

function decodeModelsFileError(value: unknown): ModelsFileError | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !modelsErrorKinds.has(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  const location = decodeModelsErrorLocation(value.location);
  if (value.location !== undefined && location === undefined) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind as ModelsFileError["kind"],
    message: value.message,
    ...(location === undefined ? {} : { location }),
  });
}

function decodeModelsErrorLocation(value: unknown):
  | {
      readonly line: number;
      readonly column: number;
      readonly position?: number;
    }
  | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.line) ||
    (value.line as number) < 1 ||
    !Number.isSafeInteger(value.column) ||
    (value.column as number) < 1
  ) {
    return undefined;
  }
  const position = value.position;
  if (
    position !== undefined &&
    (typeof position !== "number" || !Number.isSafeInteger(position))
  ) {
    return undefined;
  }
  return Object.freeze({
    line: value.line as number,
    column: value.column as number,
    ...(position === undefined ? {} : { position: position as number }),
  });
}

/**
 * Strict structural decode of the full models.json catalog result crossing
 * the bridge; the renderer keeps only value-free errors and exact bytes.
 *
 * Boundary decision: this decoder is deliberately independent from the
 * Control Plane package's wire decoders — the bridge is a trust boundary and
 * the renderer validates defensively — but it is kept aligned with the wire
 * validation rules so both sides accept and reject the same shapes. Any
 * divergence must be covered by focused tests on both sides.
 */
export function decodeModelsCommandResult(
  value: unknown,
): ModelsCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "invalid" &&
      value.outcome !== "storage_failure")
  ) {
    return undefined;
  }
  const state = value.state;
  if (
    !isRecord(state) ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0 ||
    typeof state.path !== "string" ||
    state.path.length === 0 ||
    typeof state.present !== "boolean" ||
    typeof state.valid !== "boolean" ||
    typeof state.raw !== "string"
  ) {
    return undefined;
  }
  const error = decodeModelsFileError(state.error);
  if (state.error !== undefined && error === undefined) return undefined;
  if (state.valid && error !== undefined) return undefined;
  const providers = state.providers;
  if (providers !== undefined && !isRecord(providers)) return undefined;
  if (!state.present && providers !== undefined) return undefined;
  if (providers !== undefined && !state.valid) return undefined;
  if (providers === undefined && state.present && state.valid) {
    return undefined;
  }
  // Ticket 09: a valid state carries exactly the effective catalog; an
  // invalid state never does.
  const catalog = decodeEffectiveCatalog(state.catalog);
  if (state.catalog !== undefined && catalog === undefined) {
    return undefined;
  }
  if (state.valid && catalog === undefined) return undefined;
  if (!state.valid && catalog !== undefined) return undefined;
  const commandError = decodeModelsFileError(value.error);
  if (value.error !== undefined && commandError === undefined) {
    return undefined;
  }
  if (value.outcome === "invalid") {
    if (commandError === undefined) return undefined;
  }
  if (value.outcome === "storage_failure") {
    if (commandError === undefined || commandError.kind !== "storage") {
      return undefined;
    }
  }
  if (value.outcome !== "invalid" && value.outcome !== "storage_failure") {
    if (commandError !== undefined) return undefined;
  }
  return Object.freeze({
    outcome: value.outcome as ModelsCommandResult["outcome"],
    state: Object.freeze({
      revision: state.revision as number,
      path: state.path,
      present: state.present,
      valid: state.valid,
      raw: state.raw,
      ...(providers === undefined ? {} : { providers }),
      ...(catalog === undefined ? {} : { catalog }),
      ...(error === undefined ? {} : { error }),
    }),
    ...(commandError === undefined ? {} : { error: commandError }),
  });
}

const catalogProviderStates: ReadonlySet<string> = new Set([
  "known",
  "cached",
  "refreshing",
  "succeeded",
  "failed",
]);

const catalogModelAvailability: ReadonlySet<string> = new Set([
  "available",
  "unavailable",
  "unknown",
]);

/** Sanitized catalog lifecycle projection from the status snapshot: the
 *  renderer accepts only the bounded version/refreshing/failed shape. */
export function decodeCatalogStatusProjection(
  value: unknown,
): CatalogStatusProjection | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.refreshing !== "boolean" ||
    !Array.isArray(value.failedProviderIds) ||
    value.failedProviderIds.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  if (
    value.refreshedAt !== undefined &&
    typeof value.refreshedAt !== "number"
  ) {
    return undefined;
  }
  return Object.freeze({
    version: value.version as number,
    refreshing: value.refreshing,
    ...(value.refreshedAt === undefined
      ? {}
      : { refreshedAt: value.refreshedAt as number }),
    failedProviderIds: Object.freeze([...value.failedProviderIds]),
  });
}

function decodeCatalogModel(
  value: unknown,
): CatalogModelProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.dynamic !== "boolean" ||
    typeof value.availability !== "string" ||
    !catalogModelAvailability.has(value.availability)
  ) {
    return undefined;
  }
  return Object.freeze({
    id: value.id,
    dynamic: value.dynamic,
    availability: value.availability as CatalogModelAvailability,
  });
}

function decodeCatalogProvider(
  value: unknown,
): CatalogProviderProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.dynamic !== "boolean" ||
    typeof value.state !== "string" ||
    !catalogProviderStates.has(value.state) ||
    !Array.isArray(value.models)
  ) {
    return undefined;
  }
  const models = value.models.map(decodeCatalogModel);
  if (models.some((entry) => entry === undefined)) return undefined;
  if (
    (value.error !== undefined && typeof value.error !== "string") ||
    (value.errorCode !== undefined && typeof value.errorCode !== "string") ||
    (value.refreshedAt !== undefined &&
      typeof value.refreshedAt !== "number") ||
    (value.cachedAt !== undefined && typeof value.cachedAt !== "number")
  ) {
    return undefined;
  }
  if (value.state !== "failed" && value.error !== undefined) {
    return undefined;
  }
  if (value.state !== "failed" && value.errorCode !== undefined) {
    return undefined;
  }
  if (value.state === "failed" && value.error === undefined) {
    return undefined;
  }
  return Object.freeze({
    providerId: value.providerId,
    name: value.name,
    dynamic: value.dynamic,
    state: value.state as CatalogProviderState,
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.errorCode === undefined
      ? {}
      : { errorCode: value.errorCode as string }),
    ...(value.refreshedAt === undefined
      ? {}
      : { refreshedAt: value.refreshedAt as number }),
    ...(value.cachedAt === undefined
      ? {}
      : { cachedAt: value.cachedAt as number }),
    models: Object.freeze(
      models.filter(
        (entry): entry is CatalogModelProjection => entry !== undefined,
      ),
    ),
  });
}

function decodeCatalogRefreshError(
  value: unknown,
): CatalogRefreshErrorProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    providerId: value.providerId,
    code: value.code,
    message: value.message,
  });
}

/** Strict decode of the full catalog snapshot crossing the bridge. */
export function decodeCatalogSnapshotProjection(
  value: unknown,
): CatalogSnapshotProjection | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.modelsJsonValid !== "boolean" ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.refreshErrors)
  ) {
    return undefined;
  }
  const providers = value.providers.map(decodeCatalogProvider);
  if (providers.some((entry) => entry === undefined)) return undefined;
  const refreshErrors = value.refreshErrors.map(decodeCatalogRefreshError);
  if (refreshErrors.some((entry) => entry === undefined)) return undefined;
  if (
    value.refreshedAt !== undefined &&
    typeof value.refreshedAt !== "number"
  ) {
    return undefined;
  }
  const error = decodeModelsFileError(value.modelsJsonError);
  if (value.modelsJsonError !== undefined && error === undefined) {
    return undefined;
  }
  if (!value.modelsJsonValid && error === undefined) return undefined;
  if (value.modelsJsonValid && error !== undefined) return undefined;
  return Object.freeze({
    version: value.version as number,
    modelsJsonValid: value.modelsJsonValid,
    ...(error === undefined ? {} : { modelsJsonError: error }),
    ...(value.refreshedAt === undefined
      ? {}
      : { refreshedAt: value.refreshedAt as number }),
    providers: Object.freeze(
      providers.filter(
        (entry): entry is CatalogProviderProjection => entry !== undefined,
      ),
    ),
    refreshErrors: Object.freeze(
      refreshErrors.filter(
        (entry): entry is CatalogRefreshErrorProjection => entry !== undefined,
      ),
    ),
  });
}

function decodeCatalogRefreshReport(
  value: unknown,
): CatalogRefreshReportProjection | undefined {
  if (
    !isRecord(value) ||
    value.trigger !== "manual" ||
    typeof value.startedAt !== "number" ||
    typeof value.finishedAt !== "number" ||
    !Array.isArray(value.providers)
  ) {
    return undefined;
  }
  const providers = value.providers.map(
    (
      entry: unknown,
    ): CatalogRefreshReportProjection["providers"][number] | undefined => {
      if (!isRecord(entry) || typeof entry.providerId !== "string") {
        return undefined;
      }
      if (
        entry.outcome !== "succeeded" &&
        entry.outcome !== "failed" &&
        entry.outcome !== "skipped"
      ) {
        return undefined;
      }
      if (
        (entry.error !== undefined && typeof entry.error !== "string") ||
        (entry.errorCode !== undefined && typeof entry.errorCode !== "string")
      ) {
        return undefined;
      }
      if (entry.outcome !== "failed" && entry.error !== undefined) {
        return undefined;
      }
      return Object.freeze({
        providerId: entry.providerId,
        outcome: entry.outcome,
        ...(entry.error === undefined ? {} : { error: entry.error as string }),
        ...(entry.errorCode === undefined
          ? {}
          : { errorCode: entry.errorCode as string }),
      });
    },
  );
  if (providers.some((entry) => entry === undefined)) return undefined;
  return Object.freeze({
    trigger: "manual" as const,
    startedAt: value.startedAt as number,
    finishedAt: value.finishedAt as number,
    providers: Object.freeze(
      providers.filter(
        (entry): entry is CatalogRefreshReportProjection["providers"][number] =>
          entry !== undefined,
      ),
    ),
  });
}

/** Strict decode of a versioned catalog command result crossing the
 *  bridge; only the bounded snapshot + manual report shapes are accepted. */
export function decodeCatalogCommandResult(
  value: unknown,
): CatalogCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "scheduled" &&
      value.outcome !== "unavailable")
  ) {
    return undefined;
  }
  const snapshot = decodeCatalogSnapshotProjection(value.snapshot);
  if (snapshot === undefined) return undefined;
  const refresh =
    value.refresh === undefined
      ? undefined
      : decodeCatalogRefreshReport(value.refresh);
  if (value.refresh !== undefined && refresh === undefined) {
    return undefined;
  }
  if (value.outcome !== "ok" && refresh !== undefined) return undefined;
  return Object.freeze({
    outcome: value.outcome as CatalogCommandResult["outcome"],
    snapshot,
    ...(refresh === undefined ? {} : { refresh }),
  });
}

const aliasValidationCodes: ReadonlySet<string> = new Set([
  "invalid",
  "ambiguous",
  "unknown",
  "duplicate",
]);

const aliasErrorKinds: ReadonlySet<string> = new Set([
  "parse",
  "schema",
  "validation",
  "load",
  "storage",
]);

function decodeAliasValidationErrorProjection(
  value: unknown,
): AliasValidationErrorProjection | undefined {
  if (
    !isRecord(value) ||
    // The failing alias may itself be the invalid input (e.g. an empty
    // key), so any string is a valid error entry.
    typeof value.alias !== "string" ||
    typeof value.code !== "string" ||
    !aliasValidationCodes.has(value.code) ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({
    alias: value.alias,
    code: value.code as AliasValidationErrorProjection["code"],
    message: value.message,
  });
}

function decodeAliasFileErrorProjection(
  value: unknown,
): AliasFileError | undefined {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !aliasErrorKinds.has(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  const rawEntries = value.entries;
  if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
    return undefined;
  }
  const entries =
    rawEntries === undefined
      ? undefined
      : rawEntries
          .map(decodeAliasValidationErrorProjection)
          .filter(
            (entry): entry is NonNullable<typeof entry> => entry !== undefined,
          );
  if (rawEntries !== undefined && entries?.length !== rawEntries.length) {
    return undefined;
  }
  // Per-alias entries exist exactly for the validation kind.
  if (value.kind !== "validation" && value.entries !== undefined) {
    return undefined;
  }
  if (value.kind === "validation" && value.entries === undefined) {
    return undefined;
  }
  return Object.freeze({
    kind: value.kind as AliasFileError["kind"],
    message: value.message,
    ...(entries === undefined ? {} : { entries: Object.freeze(entries) }),
  });
}

function decodeAliasTargetRef(value: unknown): {
  readonly provider: string;
  readonly model: string;
} | undefined {
  if (
    !isRecord(value) ||
    typeof value.provider !== "string" ||
    value.provider.length === 0 ||
    typeof value.model !== "string" ||
    value.model.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({ provider: value.provider, model: value.model });
}

function decodeEffectiveAliasProjection(
  value: unknown,
): {
  readonly alias: string;
  readonly target: { readonly provider: string; readonly model: string };
  readonly layer: "default" | "user";
} | undefined {
  if (
    !isRecord(value) ||
    typeof value.alias !== "string" ||
    value.alias.length === 0 ||
    (value.layer !== "default" && value.layer !== "user")
  ) {
    return undefined;
  }
  const target = decodeAliasTargetRef(value.target);
  if (target === undefined) return undefined;
  return Object.freeze({
    alias: value.alias,
    target,
    layer: value.layer as "default" | "user",
  });
}

function decodeEffectiveAliasRegistryProjection(
  value: unknown,
): {
  readonly defaultsVersion: number;
  readonly aliases: readonly {
    readonly alias: string;
    readonly target: { readonly provider: string; readonly model: string };
    readonly layer: "default" | "user";
  }[];
  readonly errors: readonly AliasValidationErrorProjection[];
} | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.defaultsVersion) ||
    (value.defaultsVersion as number) < 0 ||
    !Array.isArray(value.aliases) ||
    !Array.isArray(value.errors)
  ) {
    return undefined;
  }
  const aliases = value.aliases
    .map(decodeEffectiveAliasProjection)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (aliases.length !== value.aliases.length) return undefined;
  const errors = value.errors
    .map(decodeAliasValidationErrorProjection)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (errors.length !== value.errors.length) return undefined;
  return Object.freeze({
    defaultsVersion: value.defaultsVersion as number,
    aliases: Object.freeze(aliases),
    errors: Object.freeze(errors),
  });
}

/** Strict decode of the full alias registry state crossing the bridge; the
 *  renderer keeps only value-free errors, the parsed user record and the
 *  authoritative effective registry. */
export function decodeAliasCommandResult(
  value: unknown,
): AliasCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "invalid" &&
      value.outcome !== "storage_failure")
  ) {
    return undefined;
  }
  const state = value.state;
  if (
    !isRecord(state) ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0 ||
    typeof state.path !== "string" ||
    state.path.length === 0 ||
    typeof state.present !== "boolean" ||
    typeof state.valid !== "boolean" ||
    typeof state.raw !== "string" ||
    !Number.isSafeInteger(state.defaultsVersion) ||
    (state.defaultsVersion as number) < 0 ||
    !Number.isSafeInteger(state.catalogVersion) ||
    (state.catalogVersion as number) < 0
  ) {
    return undefined;
  }
  const error = decodeAliasFileErrorProjection(state.error);
  if (state.error !== undefined && error === undefined) return undefined;
  const aliases = state.aliases;
  if (aliases !== undefined && !isRecord(aliases)) return undefined;
  if (!state.present && aliases !== undefined) return undefined;
  if (aliases !== undefined && !state.valid) return undefined;
  if (aliases === undefined && state.present && state.valid) return undefined;
  const effective = decodeEffectiveAliasRegistryProjection(state.effective);
  if (effective === undefined) return undefined;
  const commandError = decodeAliasFileErrorProjection(value.error);
  if (value.error !== undefined && commandError === undefined) {
    return undefined;
  }
  if (value.outcome === "invalid" && commandError === undefined) {
    return undefined;
  }
  if (value.outcome === "storage_failure" && commandError === undefined) {
    return undefined;
  }
  if (value.outcome === "ok" || value.outcome === "conflict") {
    if (commandError !== undefined) return undefined;
  }
  return Object.freeze({
    outcome: value.outcome as AliasCommandResult["outcome"],
    state: Object.freeze({
      revision: state.revision as number,
      path: state.path,
      present: state.present,
      valid: state.valid,
      raw: state.raw,
      defaultsVersion: state.defaultsVersion as number,
      catalogVersion: state.catalogVersion as number,
      ...(aliases === undefined ? {} : { aliases }),
      ...(effective === undefined ? {} : { effective }),
      ...(error === undefined ? {} : { error }),
    }),
    ...(commandError === undefined ? {} : { error: commandError }),
  });
}

/** Sanitized model-aliases.json projection from the status snapshot:
 *  revision, location, presence, validity and value-free error — never
 *  content. */
export function decodeAliasStatusProjection(
  value: unknown,
): AliasStatusProjection | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean" ||
    !Number.isSafeInteger(value.defaultsVersion) ||
    (value.defaultsVersion as number) < 0
  ) {
    return undefined;
  }
  const error = decodeAliasFileErrorProjection(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    defaultsVersion: value.defaultsVersion as number,
    ...(error === undefined ? {} : { error }),
  });
}

/** Sanitized models.json projection from the status snapshot: revision,
 *  location, presence, validity and value-free error — never content. */
export function decodeModelsProjection(
  value: unknown,
): ModelsProjection | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean"
  ) {
    return undefined;
  }
  const error = decodeModelsFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  if (value.valid && error !== undefined) return undefined;
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    ...(error === undefined ? {} : { error }),
  });
}

/** Sanitized auth.json credential projection from the status snapshot:
 *  file facts plus bounded per-Provider status rows; strict decoding so
 *  credential values or raw credential shapes never reach the renderer. */
export function decodeCredentialProjection(
  value: unknown,
  options: { readonly allowEmptyPath?: boolean } = {},
): CredentialProjection | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.path !== "string" ||
    (value.path.length === 0 && options.allowEmptyPath !== true) ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean" ||
    !Array.isArray(value.providers)
  ) {
    return undefined;
  }
  const error = decodeCredentialFileError(value.error);
  if (value.error !== undefined && error === undefined) return undefined;
  if (value.valid && error !== undefined) return undefined;
  const providers: ProviderAuthStatus[] = [];
  for (const raw of value.providers) {
    const row = decodeProviderAuthStatus(raw);
    if (row === undefined) return undefined;
    providers.push(row);
  }
  return Object.freeze({
    revision: value.revision as number,
    path: value.path,
    present: value.present,
    valid: value.valid,
    ...(error === undefined ? {} : { error }),
    providers: Object.freeze(providers),
  });
}

function decodeCredentialFileError(
  value: unknown,
): CredentialFileError | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== "parse" &&
      value.kind !== "invalid" &&
      value.kind !== "load") ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return undefined;
  }
  return Object.freeze({ kind: value.kind, message: value.message });
}

function decodeProviderAuthStatus(
  value: unknown,
): ProviderAuthStatus | undefined {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.stored !== "boolean" ||
    (value.storedType !== undefined &&
      value.storedType !== "api_key" &&
      value.storedType !== "oauth") ||
    typeof value.environment !== "boolean" ||
    typeof value.modelsJson !== "boolean" ||
    typeof value.commandDerived !== "boolean" ||
    typeof value.expired !== "boolean" ||
    typeof value.unavailable !== "boolean" ||
    (value.effectiveSource !== "stored" &&
      value.effectiveSource !== "environment" &&
      value.effectiveSource !== "models.json" &&
      value.effectiveSource !== "command" &&
      value.effectiveSource !== "none")
  ) {
    return undefined;
  }
  // Stored presence is a fact; the effective source follows request-time
  // precedence and may differ when a stored reference cannot resolve.
  if (value.unavailable !== (value.effectiveSource === "none"))
    return undefined;
  if (value.stored === true && value.storedType === undefined) return undefined;
  if (value.stored === false && value.storedType !== undefined)
    return undefined;
  return Object.freeze({
    providerId: value.providerId,
    stored: value.stored,
    ...(value.storedType === undefined ? {} : { storedType: value.storedType }),
    environment: value.environment,
    modelsJson: value.modelsJson,
    commandDerived: value.commandDerived,
    expired: value.expired,
    unavailable: value.unavailable,
    effectiveSource: value.effectiveSource,
  });
}

/** Per-command validation of a Credential command result (Ticket 12): the
 *  renderer accepts only the sanitized projection, closed outcomes and the
 *  per-command extras — a credential value or raw credential shape can
 *  never pass. */
export function decodeCredentialCommandResult(
  value: unknown,
  command: CredentialCommand,
): CredentialCommandResult | undefined {
  if (
    !isRecord(value) ||
    (value.outcome !== "ok" &&
      value.outcome !== "conflict" &&
      value.outcome !== "invalid" &&
      value.outcome !== "unknown_provider" &&
      value.outcome !== "overwrite_required" &&
      value.outcome !== "storage_failure" &&
      value.outcome !== "unavailable") ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return undefined;
  }
  const outcome = value.outcome as CredentialCommandResult["outcome"];
  const revision = value.revision as number;
  // The unavailable DTO carries a minimal value-free state (no path exists
  // while the authority is not running); every other outcome requires a
  // normal non-empty projection.
  const state = decodeCredentialProjection(value.state, {
    allowEmptyPath: outcome === "unavailable",
  });
  if (state === undefined) return undefined;
  if (outcome !== "ok") {
    if (typeof value.error !== "string" || value.error.length === 0) {
      return undefined;
    }
    if (command.command === "import_apply") {
      const entries = decodeImportApplyEntries(value.entries);
      if (entries === undefined) return undefined;
      return { outcome, revision, state, error: value.error, entries };
    }
    if (value.entries !== undefined) return undefined;
    return { outcome, revision, state, error: value.error };
  }
  if (command.command === "login" || command.command === "logout") {
    if (value.changed !== undefined && typeof value.changed !== "boolean") {
      return undefined;
    }
    return {
      outcome,
      revision,
      state,
      ...(value.changed === undefined ? {} : { changed: value.changed }),
    };
  }
  if (command.command === "import_preview") {
    if (
      typeof value.importId !== "string" ||
      value.importId.length === 0 ||
      !Array.isArray(value.previewEntries)
    ) {
      return undefined;
    }
    const previewEntries: CredentialImportEntryPreview[] = [];
    for (const raw of value.previewEntries) {
      if (
        !isRecord(raw) ||
        typeof raw.providerId !== "string" ||
        raw.providerId.length === 0 ||
        (raw.type !== "api_key" && raw.type !== "oauth") ||
        typeof raw.wouldOverwrite !== "boolean"
      ) {
        return undefined;
      }
      previewEntries.push({
        providerId: raw.providerId,
        type: raw.type,
        wouldOverwrite: raw.wouldOverwrite,
      });
    }

    return {
      outcome,
      revision,
      state,
      importId: value.importId,
      previewEntries: Object.freeze(previewEntries),
    };
  }
  if (command.command === "import_apply") {
    const entries = decodeImportApplyEntries(value.entries);
    if (entries === undefined) return undefined;
    return { outcome, revision, state, entries };
  }
  if (value.changed !== undefined || value.importId !== undefined) {
    return undefined;
  }
  return { outcome, revision, state };
}

function decodeImportApplyEntries(
  value: unknown,
): readonly CredentialImportApplyEntryResult[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: CredentialImportApplyEntryResult[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.providerId !== "string" ||
      raw.providerId.length === 0 ||
      (raw.outcome !== "applied" &&
        raw.outcome !== "unchanged" &&
        raw.outcome !== "skipped" &&
        raw.outcome !== "conflict" &&
        raw.outcome !== "overwrite_required")
    ) {
      return undefined;
    }
    entries.push({
      providerId: raw.providerId,
      outcome: raw.outcome,
    });
  }
  return Object.freeze(entries);
}

/** Developer Lab exposes only the settings the product UI actively renders.
 *  Unknown keys, ambient internal variables, unregistered experimental flags,
 *  and secret values never reach the renderer. */
const rendererSettingKeys: ReadonlySet<string> = new Set([
  "protocols.anthropic-messages.enabled",
  "protocols.openai-responses.enabled",
  "server.port",
  "server.bindHost",
]);

function projectSettings(
  raw: unknown,
): Readonly<Record<string, RendererRegisteredSetting>> | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Record<string, RendererRegisteredSetting> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (!rendererSettingKeys.has(key)) continue;
    const setting = decodeRendererSetting(value);
    if (setting === undefined || setting.key !== key) continue;
    if (setting.sensitivity !== "public") continue;
    result[key] = setting;
  }
  return Object.freeze(result);
}

const unavailableCopy: Readonly<
  Record<
    ControlPlaneUnavailableReason,
    Omit<ControlPlaneErrorState, "revision" | "kind" | "code">
  >
> = {
  descriptor_missing: {
    title: "LuckyToken backend is not available",
    detail: "No active local Control Plane was found.",
    action: "Start LuckyToken, then reconnect.",
  },
  descriptor_invalid: {
    title: "LuckyToken connection information is invalid",
    detail: "The local Control Plane descriptor could not be validated.",
    action: "Restart LuckyToken, then reconnect.",
  },
  pipe_unavailable: {
    title: "LuckyToken backend is not reachable",
    detail: "The active local Control Plane could not be opened.",
    action: "Restart LuckyToken, then reconnect.",
  },
  protocol_error: {
    title: "LuckyToken connection failed",
    detail: "The local Control Plane returned an invalid response.",
    action: "Restart LuckyToken; update it if the problem continues.",
  },
};

function decodeOwnership(value: unknown): ApplicationOwnership | undefined {
  if (!isRecord(value) || !isRecord(value.owner)) return undefined;
  const owner = value.owner;
  if (
    (owner.kind !== "cli" && owner.kind !== "desktop") ||
    !Number.isSafeInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.startedAt !== "string" ||
    Number.isNaN(Date.parse(owner.startedAt))
  ) {
    return undefined;
  }
  return Object.freeze({
    owner: Object.freeze({
      kind: owner.kind as "cli" | "desktop",
      pid: owner.pid as number,
      startedAt: owner.startedAt as string,
    }),
  });
}

export function projectControlPlaneState(
  payload: ControlPlaneBridgePayload,
): ControlPlaneState {
  if (payload.connection === "connected") {
    const dataPlane = payload.snapshot.dataPlane;
    const settings = projectSettings(payload.snapshot.settings);
    const modelsProjection =
      payload.snapshot.models === undefined
        ? undefined
        : decodeModelsProjection(payload.snapshot.models);
    const credentialsProjection =
      payload.snapshot.credentials === undefined
        ? undefined
        : decodeCredentialProjection(payload.snapshot.credentials);
    const catalogStatus =
      payload.snapshot.catalog === undefined
        ? undefined
        : decodeCatalogStatusProjection(payload.snapshot.catalog);
    const aliasesProjection =
      payload.snapshot.aliases === undefined
        ? undefined
        : decodeAliasStatusProjection(payload.snapshot.aliases);
    const confirmation = payload.snapshot.confirmation;
    const projectedConfirmation =
      confirmation === undefined ||
      !isRecord(confirmation) ||
      typeof confirmation.actionId !== "string" ||
      confirmation.actionId.length === 0 ||
      confirmation.settingKey !== "server.bindHost" ||
      typeof confirmation.value !== "string" ||
      typeof confirmation.message !== "string"
        ? undefined
        : Object.freeze({
            actionId: confirmation.actionId,
            settingKey: "server.bindHost" as const,
            value: confirmation.value,
            message: confirmation.message,
          });
    const ownership = decodeOwnership(payload.snapshot.ownership);
    if (payload.snapshot.ownership !== undefined && ownership === undefined) {
      // A connected snapshot whose owner identity is malformed cannot be
      // trusted for lifecycle decisions (quit, attach, auto-start).
      return Object.freeze({
        revision: payload.revision,
        kind: "error",
        code: "protocol_error",
        ...unavailableCopy.protocol_error,
      });
    }
    return Object.freeze({
      revision: payload.revision,
      kind: "connected",
      applicationVersion: payload.applicationVersion,
      contractVersion: payload.contractVersion,
      sequence: payload.snapshot.sequence,
      modelDataPlane: payload.snapshot.modelDataPlane,
      provider: payload.snapshot.provider,
      ...(dataPlane === undefined
        ? {}
        : {
            dataPlane: Object.freeze({
              configuredOrigin: dataPlane.configuredOrigin,
              configuredPort: dataPlane.configuredPort,
              ...(dataPlane.failure === undefined
                ? {}
                : {
                    failure: Object.freeze({
                      code: dataPlane.failure.code,
                      message: dataPlaneFailureCopy[dataPlane.failure.code],
                    }),
                  }),
            }),
          }),
      ...(settings === undefined ? {} : { settings }),
      ...(modelsProjection === undefined ? {} : { modelsProjection }),
      ...(credentialsProjection === undefined ? {} : { credentialsProjection }),
      ...(catalogStatus === undefined ? {} : { catalogStatus }),
      ...(aliasesProjection === undefined
        ? {}
        : { aliasesProjection }),
      ...(projectedConfirmation === undefined
        ? {}
        : { confirmation: projectedConfirmation }),
      ...(ownership === undefined ? {} : { ownership }),
    });
  }
  if (payload.connection === "version_mismatch") {
    const supported = payload.supportedVersions.join(", ");
    return Object.freeze({
      revision: payload.revision,
      kind: "error",
      code: "version_mismatch",
      title: "Desktop update required",
      detail: `This desktop supports Control Plane v${payload.requestedVersion}; the active backend supports v${supported}.`,
      action: "Install matching LuckyToken desktop and backend versions.",
    });
  }
  if (payload.connection === "disconnected") {
    return Object.freeze({
      revision: payload.revision,
      kind: "error",
      code: "transport_lost",
      title: "Connection to LuckyToken was lost",
      detail: "The active local Control Plane disconnected.",
      action: "Restart LuckyToken, then reconnect.",
    });
  }
  return Object.freeze({
    revision: payload.revision,
    kind: "error",
    code: payload.reason,
    ...unavailableCopy[payload.reason],
  });
}

const dataPlaneFailureCopy = {
  port_in_use:
    "The configured port is already in use. Stop the other application or choose a different port.",
  start_failed:
    "The model gateway could not start. Check its configured address and try again.",
  stop_failed:
    "The model gateway could not stop cleanly. Restart LuckyToken before trying again.",
} as const;
