import { isAbsolute, resolve } from "node:path";

export interface DiagnosticsConfiguration {
  readonly directory: string;
  /** Hard cap for one redacted JSON artifact: 64 MiB. */
  readonly maxJsonArtifactBytes: number;
  /** Aggregate hard cap for one Request Journey: 512 MiB. */
  readonly maxJourneyArtifactBytes: number;
  /** Process-owned artifact-file retention cap. */
  readonly maxArtifactDiskBytes: number;
  readonly artifactRetentionAgeMs: number;
  readonly maxArtifactJourneys: number;
}

const CONFIGURATION_SCHEMA = "Token.diagnostics.configuration.v2";
const CONFIGURATION_MARKER = "__TokenDiagnosticsConfigurationV2";

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
      key !== "maxJsonArtifactBytes" &&
      key !== "maxJourneyArtifactBytes" &&
      key !== "maxArtifactDiskBytes" &&
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
  const maxJsonArtifactBytes = positiveIntegerAtMost(
    root.maxJsonArtifactBytes ?? 67_108_864,
    67_108_864,
    `${path}.maxJsonArtifactBytes`,
  );
  const maxJourneyArtifactBytes = positiveIntegerAtMost(
    root.maxJourneyArtifactBytes ?? 536_870_912,
    536_870_912,
    `${path}.maxJourneyArtifactBytes`,
  );
  const maxArtifactDiskBytes = positiveIntegerAtMost(
    root.maxArtifactDiskBytes ?? 5_368_709_120,
    1_099_511_627_776,
    `${path}.maxArtifactDiskBytes`,
  );
  if (maxJsonArtifactBytes > maxJourneyArtifactBytes) {
    throw new Error(
      `${path}.maxJsonArtifactBytes must not exceed ${path}.maxJourneyArtifactBytes`,
    );
  }
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
    maxJsonArtifactBytes,
    maxJourneyArtifactBytes,
    maxArtifactDiskBytes,
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
