import { isAbsolute, resolve } from "node:path";

export interface DiagnosticsConfiguration {
  readonly directory: string;
  readonly successArtifacts: Readonly<{ readonly enabled: boolean }>;
  readonly maxJourneyArtifactBytes: number;
  readonly artifactRetentionAgeMs: number;
  readonly maxArtifactJourneys: number;
}

const CONFIGURATION_SCHEMA = "luckytoken.diagnostics.configuration.v1";
const CONFIGURATION_MARKER = "__luckytokenDiagnosticsConfigurationV1";

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveIntegerAtMost(
  value: unknown,
  maximum: number,
  path: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new Error(`${path} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

export function parseDiagnosticsConfiguration(
  value: unknown,
  configDirectory: string,
  path = "diagnostics",
): DiagnosticsConfiguration {
  const root = object(value ?? {}, path);
  for (const key of Object.keys(root)) {
    if (
      key !== "directory" &&
      key !== "successArtifacts" &&
      key !== "maxJourneyArtifactBytes" &&
      key !== "artifactRetentionAgeMs" &&
      key !== "maxArtifactJourneys"
    ) {
      throw new Error(`${path}.${key} is unknown`);
    }
  }
  const rawDirectory = root.directory ?? "state/request-diagnostics";
  if (typeof rawDirectory !== "string" || rawDirectory.trim().length === 0) {
    throw new Error(`${path}.directory must be a non-empty string`);
  }
  const directory = isAbsolute(rawDirectory)
    ? resolve(rawDirectory)
    : resolve(configDirectory, rawDirectory);
  const successArtifacts = object(
    root.successArtifacts ?? {},
    `${path}.successArtifacts`,
  );
  for (const key of Object.keys(successArtifacts)) {
    if (key !== "enabled") {
      throw new Error(`${path}.successArtifacts.${key} is unknown`);
    }
  }
  const enabled = successArtifacts.enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error(`${path}.successArtifacts.enabled must be a boolean`);
  }
  const maxJourneyArtifactBytes = positiveIntegerAtMost(
    root.maxJourneyArtifactBytes ?? 4_194_304,
    4_194_304,
    `${path}.maxJourneyArtifactBytes`,
  );
  const artifactRetentionAgeMs = positiveIntegerAtMost(
    root.artifactRetentionAgeMs ?? 604_800_000,
    604_800_000,
    `${path}.artifactRetentionAgeMs`,
  );
  const maxArtifactJourneys = positiveIntegerAtMost(
    root.maxArtifactJourneys ?? 1_000,
    1_000,
    `${path}.maxArtifactJourneys`,
  );
  return Object.freeze({
    directory,
    successArtifacts: Object.freeze({ enabled }),
    maxJourneyArtifactBytes,
    artifactRetentionAgeMs,
    maxArtifactJourneys,
    [CONFIGURATION_MARKER]: CONFIGURATION_SCHEMA,
  });
}

export function bindDiagnosticsConfiguration(
  value: unknown,
): DiagnosticsConfiguration {
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, CONFIGURATION_MARKER) ||
    (value as Record<string, unknown>)[CONFIGURATION_MARKER] !==
      CONFIGURATION_SCHEMA
  ) {
    throw new Error(
      "diagnostics configuration is not a diagnostics-owned snapshot",
    );
  }
  return value as DiagnosticsConfiguration;
}
