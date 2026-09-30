import { parse, patch } from "@decimalturn/toml-patch";

export interface CodexManagedConfigValues {
  readonly modelProvider: string | null;
  readonly openaiBaseUrl: string | null;
  readonly modelCatalogJson: string | null;
  readonly standaloneWebSearch: boolean | null;
}

export const CODEX_NATIVE_CONFIG_TARGET: CodexManagedConfigValues = Object.freeze({
  modelProvider: null,
  openaiBaseUrl: null,
  modelCatalogJson: null,
  standaloneWebSearch: null,
});

export type CodexManagedConfigInspection =
  | {
      readonly ok: true;
      readonly values: CodexManagedConfigValues;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRoot(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new Error("Codex config.toml is not valid TOML.", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("Codex config.toml root must be a TOML table.");
  }
  return parsed;
}

function readOptionalString(
  root: Record<string, unknown>,
  key: "model_provider" | "openai_base_url" | "model_catalog_json",
): string | null {
  if (!Object.prototype.hasOwnProperty.call(root, key)) return null;
  const value = root[key];
  if (typeof value !== "string") {
    throw new Error(`Codex config.toml ${key} must be a string.`);
  }
  return value;
}

function readFeatures(
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(root, "features")) return undefined;
  const value = root.features;
  if (!isRecord(value)) {
    throw new Error("Codex config.toml features must be a table.");
  }
  return value;
}

function valuesFromRoot(root: Record<string, unknown>): CodexManagedConfigValues {
  const features = readFeatures(root);
  let standaloneWebSearch: boolean | null = null;
  if (
    features !== undefined &&
    Object.prototype.hasOwnProperty.call(features, "standalone_web_search")
  ) {
    const value = features.standalone_web_search;
    if (typeof value !== "boolean") {
      throw new Error(
        "Codex config.toml features.standalone_web_search must be a boolean.",
      );
    }
    standaloneWebSearch = value;
  }

  return Object.freeze({
    modelProvider: readOptionalString(root, "model_provider"),
    openaiBaseUrl: readOptionalString(root, "openai_base_url"),
    modelCatalogJson: readOptionalString(root, "model_catalog_json"),
    standaloneWebSearch,
  });
}

export function sameCodexManagedConfigValues(
  left: CodexManagedConfigValues,
  right: CodexManagedConfigValues,
): boolean {
  return (
    left.modelProvider === right.modelProvider &&
    left.openaiBaseUrl === right.openaiBaseUrl &&
    left.modelCatalogJson === right.modelCatalogJson &&
    left.standaloneWebSearch === right.standaloneWebSearch
  );
}

export function inspectCodexManagedConfig(
  content: string,
): CodexManagedConfigInspection {
  try {
    return Object.freeze({
      ok: true as const,
      values: valuesFromRoot(parseRoot(content)),
    });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      message:
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Codex config.toml could not be read safely.",
    });
  }
}

export function patchCodexManagedConfig(
  content: string,
  target: CodexManagedConfigValues,
): string {
  const root = parseRoot(content);

  // Validate managed containers before mutating the parsed representation. A
  // scalar-to-table replacement could otherwise delete unrelated TOML nested
  // below one of these paths.
  valuesFromRoot(root);

  const setString = (
    key: "model_provider" | "openai_base_url" | "model_catalog_json",
    value: string | null,
  ): void => {
    if (value === null) delete root[key];
    else root[key] = value;
  };

  setString("model_provider", target.modelProvider);
  setString("openai_base_url", target.openaiBaseUrl);
  setString("model_catalog_json", target.modelCatalogJson);

  let features = readFeatures(root);
  if (target.standaloneWebSearch === null) {
    if (features !== undefined) delete features.standalone_web_search;
  } else {
    if (features === undefined) {
      features = {};
      root.features = features;
    }
    features.standalone_web_search = target.standaloneWebSearch;
  }

  let result: string;
  try {
    result = patch(content, root);
  } catch (error) {
    throw new Error("Codex config.toml could not be patched safely.", {
      cause: error,
    });
  }

  const verified = inspectCodexManagedConfig(result);
  if (!verified.ok || !sameCodexManagedConfigValues(verified.values, target)) {
    throw new Error(
      verified.ok
        ? "Codex config.toml patch did not retain the requested managed values."
        : verified.message,
    );
  }
  return result;
}
