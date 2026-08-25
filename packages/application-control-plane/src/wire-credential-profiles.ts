import type {
  CredentialProfileOptionsProjection,
  CredentialProfileProjectionV1,
  CredentialProfilesCommand,
  CredentialProfilesCommandResult,
  CredentialProfilesProjectionV1,
  ProviderCredentialProfilesProjectionV1,
  ProviderProfileAuthCommand,
  ProviderProfileAuthCommandResult,
} from "./credential-profiles-contract.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function providerId(value: unknown): value is string {
  return boundedString(value, 1, 64) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function opaqueId(value: unknown): value is string {
  return boundedString(value, 1, 256) && !/[\u0000-\u001f\u007f]/u.test(value);
}

function metadata(value: unknown, maximum: number): value is string {
  return boundedString(value, 1, maximum) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function profileTarget(value: Record<string, unknown>): boolean {
  return providerId(value.providerId) &&
    opaqueId(value.credentialId) &&
    opaqueId(value.expectedRevision);
}

export function decodeCredentialProfilesCommand(
  value: unknown,
): CredentialProfilesCommand | undefined {
  if (!isObject(value) || typeof value.command !== "string") return undefined;
  switch (value.command) {
    case "query":
      if (!exactKeys(value, ["command"], ["providerIds"])) return undefined;
      if (
        value.providerIds !== undefined &&
        (!Array.isArray(value.providerIds) || !value.providerIds.every(providerId))
      ) return undefined;
      return value as unknown as CredentialProfilesCommand;
    case "update_metadata":
      if (
        !exactKeys(
          value,
          ["command", "providerId", "credentialId", "displayName", "expectedRevision"],
          ["note"],
        ) ||
        !profileTarget(value) ||
        !metadata(value.displayName, 64) ||
        (value.note !== undefined &&
          !(typeof value.note === "string" && value.note.length <= 200))
      ) return undefined;
      return value as unknown as CredentialProfilesCommand;
    case "activate":
    case "remove":
    case "recheck":
      return exactKeys(
        value,
        ["command", "providerId", "credentialId", "expectedRevision"],
      ) && profileTarget(value)
        ? value as unknown as CredentialProfilesCommand
        : undefined;
    case "set_enabled":
      return exactKeys(
        value,
        ["command", "providerId", "credentialId", "enabled", "expectedRevision"],
      ) && profileTarget(value) && typeof value.enabled === "boolean"
        ? value as unknown as CredentialProfilesCommand
        : undefined;
    case "set_priority":
      return exactKeys(
        value,
        ["command", "providerId", "credentialId", "priority", "expectedRevision"],
      ) && profileTarget(value) &&
        typeof value.priority === "number" && Number.isSafeInteger(value.priority)
        ? value as unknown as CredentialProfilesCommand
        : undefined;
    case "reorder_profiles":
      return exactKeys(
        value,
        ["command", "providerId", "credentialIds", "expectedRevision"],
      ) && providerId(value.providerId) && opaqueId(value.expectedRevision) &&
        Array.isArray(value.credentialIds) && value.credentialIds.every(opaqueId)
        ? value as unknown as CredentialProfilesCommand
        : undefined;
    case "set_switch_policy":
      return exactKeys(
        value,
        [
          "command",
          "providerId",
          "expectedRevision",
          "apiKeyOn429",
          "oauthOn429",
        ],
      ) && providerId(value.providerId) && opaqueId(value.expectedRevision) &&
        typeof value.apiKeyOn429 === "boolean" && typeof value.oauthOn429 === "boolean"
        ? value as unknown as CredentialProfilesCommand
        : undefined;
    default:
      return undefined;
  }
}

export function decodeProviderProfileAuthCommand(
  value: unknown,
): ProviderProfileAuthCommand | undefined {
  if (!isObject(value) || typeof value.command !== "string") return undefined;
  if (value.command === "query") {
    return exactKeys(value, ["command"])
      ? value as unknown as ProviderProfileAuthCommand
      : undefined;
  }
  if (value.command === "login") {
    if (
      !exactKeys(
        value,
        [
          "command",
          "providerId",
          "authType",
          "displayName",
          "useNow",
          "expectedRevision",
        ],
        ["note"],
      ) ||
      !providerId(value.providerId) ||
      (value.authType !== "api_key" && value.authType !== "oauth") ||
      !metadata(value.displayName, 64) ||
      (value.note !== undefined &&
        !(typeof value.note === "string" && value.note.length <= 200)) ||
      typeof value.useNow !== "boolean" ||
      !opaqueId(value.expectedRevision)
    ) return undefined;
    return value as unknown as ProviderProfileAuthCommand;
  }
  if (value.command === "reconnect") {
    return exactKeys(
      value,
      [
        "command",
        "providerId",
        "credentialId",
        "useNow",
        "expectedRevision",
      ],
    ) && providerId(value.providerId) && opaqueId(value.credentialId) &&
      typeof value.useNow === "boolean" && opaqueId(value.expectedRevision)
      ? value as unknown as ProviderProfileAuthCommand
      : undefined;
  }
  return undefined;
}

const HEALTH = new Set([
  "ready",
  "not_yet_verified",
  "refreshing",
  "cooling_down",
  "reconnect_required",
  "disabled",
]);

function decodeProfile(value: unknown): CredentialProfileProjectionV1 | undefined {
  if (
    !isObject(value) ||
    !exactKeys(
      value,
      [
        "credentialId",
        "authType",
        "authMethodLabel",
        "displayName",
        "enabled",
        "health",
        "priority",
        "createdAt",
        "updatedAt",
      ],
      ["note", "identityHint", "lastUsedAt", "lastSucceededAt"],
    ) ||
    !opaqueId(value.credentialId) ||
    (value.authType !== "api_key" && value.authType !== "oauth") ||
    !metadata(value.authMethodLabel, 128) ||
    !metadata(value.displayName, 64) ||
    (value.note !== undefined && !(typeof value.note === "string" && value.note.length <= 200)) ||
    (value.identityHint !== undefined && !metadata(value.identityHint, 64)) ||
    typeof value.enabled !== "boolean" ||
    typeof value.health !== "string" || !HEALTH.has(value.health) ||
    typeof value.priority !== "number" || !Number.isSafeInteger(value.priority) ||
    typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) ||
    (value.lastUsedAt !== undefined &&
      (!Number.isSafeInteger(value.lastUsedAt) || (value.lastUsedAt as number) < 0)) ||
    (value.lastSucceededAt !== undefined &&
      (!Number.isSafeInteger(value.lastSucceededAt) ||
        (value.lastSucceededAt as number) < 0))
  ) return undefined;
  return value as unknown as CredentialProfileProjectionV1;
}

function decodeProviderState(
  value: unknown,
): ProviderCredentialProfilesProjectionV1 | undefined {
  if (
    !isObject(value) ||
    !exactKeys(
      value,
      ["providerId", "implementationAvailable", "profiles"],
      [
        "revision",
        "selectionGeneration",
        "activeCredentialId",
        "switchPolicy",
        "recordError",
        "ambient",
      ],
    ) ||
    !providerId(value.providerId) ||
    typeof value.implementationAvailable !== "boolean" ||
    (value.revision !== undefined && !opaqueId(value.revision)) ||
    (value.selectionGeneration !== undefined && !opaqueId(value.selectionGeneration)) ||
    (value.activeCredentialId !== undefined && !opaqueId(value.activeCredentialId)) ||
    !Array.isArray(value.profiles)
  ) return undefined;
  const profiles = value.profiles.map(decodeProfile);
  if (profiles.some((profile) => profile === undefined)) return undefined;
  if (value.switchPolicy !== undefined) {
    if (
      !isObject(value.switchPolicy) ||
      !exactKeys(value.switchPolicy, ["apiKeyOn429", "oauthOn429"]) ||
      typeof value.switchPolicy.apiKeyOn429 !== "boolean" ||
      typeof value.switchPolicy.oauthOn429 !== "boolean"
    ) return undefined;
  }
  if (value.recordError !== undefined) {
    if (
      !isObject(value.recordError) ||
      !exactKeys(value.recordError, ["code", "message"]) ||
      (value.recordError.code !== "invalid_record" && value.recordError.code !== "storage_error") ||
      !metadata(value.recordError.message, 256)
    ) return undefined;
  }
  if (value.ambient !== undefined) {
    if (
      !isObject(value.ambient) ||
      !exactKeys(value.ambient, ["kind", "status", "message"]) ||
      value.ambient.kind !== "external" ||
      (value.ambient.status !== "configured" &&
        value.ambient.status !== "unknown") ||
      !metadata(value.ambient.message, 256)
    ) return undefined;
  }
  return value as unknown as ProviderCredentialProfilesProjectionV1;
}

export function decodeCredentialProfilesProjection(
  value: unknown,
): CredentialProfilesProjectionV1 | undefined {
  if (!isObject(value) || !exactKeys(value, ["providers"]) || !Array.isArray(value.providers)) {
    return undefined;
  }
  return value.providers.every((provider) => decodeProviderState(provider) !== undefined)
    ? value as unknown as CredentialProfilesProjectionV1
    : undefined;
}

function decodeOptions(value: unknown): CredentialProfileOptionsProjection | undefined {
  if (!isObject(value) || !exactKeys(value, ["providers"]) || !Array.isArray(value.providers)) {
    return undefined;
  }
  for (const provider of value.providers) {
    if (
      !isObject(provider) ||
      !exactKeys(provider, ["providerId", "name", "source", "authMethods"]) ||
      !providerId(provider.providerId) ||
      !metadata(provider.name, 128) ||
      (provider.source !== "pi_builtin" &&
        provider.source !== "token_bundled" &&
        provider.source !== "user") ||
      !Array.isArray(provider.authMethods)
    ) return undefined;
    for (const method of provider.authMethods) {
      if (
        !isObject(method) ||
        !exactKeys(method, ["authType", "authMethodLabel", "interactive"]) ||
        (method.authType !== "api_key" && method.authType !== "oauth") ||
        !metadata(method.authMethodLabel, 128) ||
        typeof method.interactive !== "boolean"
      ) return undefined;
    }
  }
  return value as unknown as CredentialProfileOptionsProjection;
}

function decodeResult<T extends CredentialProfilesCommandResult | ProviderProfileAuthCommandResult>(
  value: unknown,
  outcomes: ReadonlySet<string>,
): T | undefined {
  if (
    !isObject(value) ||
    !exactKeys(value, ["outcome", "state"], ["options", "error"]) ||
    typeof value.outcome !== "string" ||
    !outcomes.has(value.outcome) ||
    decodeCredentialProfilesProjection(value.state) === undefined ||
    (value.options !== undefined && decodeOptions(value.options) === undefined) ||
    (value.error !== undefined && !metadata(value.error, 256))
  ) return undefined;
  return value as unknown as T;
}

const CREDENTIAL_OUTCOMES = new Set([
  "ok",
  "conflict",
  "invalid",
  "duplicate",
  "unknown_provider",
  "unknown_profile",
  "reconnect_required",
  "storage_failure",
  "unavailable",
]);

const AUTH_OUTCOMES = new Set([
  "ok",
  "cancelled",
  "failed",
  "conflict",
  "invalid",
  "duplicate",
  "unknown_provider",
  "unknown_profile",
  "storage_failure",
  "unavailable",
]);

export function decodeCredentialProfilesCommandResult(
  value: unknown,
): CredentialProfilesCommandResult | undefined {
  return decodeResult(value, CREDENTIAL_OUTCOMES);
}

export function decodeProviderProfileAuthCommandResult(
  value: unknown,
): ProviderProfileAuthCommandResult | undefined {
  return decodeResult(value, AUTH_OUTCOMES);
}
