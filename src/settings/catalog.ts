/**
 * Authoritative registered settings catalog.
 *
 * Every stable and Developer Lab setting is registered here with its type,
 * default, validation, sensitivity, and apply mode. Values are typed and
 * validated before they can enter the registry; unregistered keys never
 * appear. Sensitivity is `public` for all current settings; sensitive
 * settings must declare `secret` and would never be rendered verbatim.
 */

export type SettingType = "boolean" | "number" | "string";

export type SettingSensitivity = "public" | "secret";

export type SettingApplyMode = "hot-apply" | "restart-required";

export type SettingValidation =
  | { readonly type: "boolean" }
  | { readonly type: "integer"; readonly minimum: number; readonly maximum: number };

export interface SettingValue {
  readonly value: boolean | number | string;
}

export interface RegisteredSetting extends SettingValue {
  readonly key: string;
  readonly type: SettingType;
  readonly default: boolean | number | string;
  readonly validation: SettingValidation;
  readonly sensitivity: SettingSensitivity;
  readonly applyMode: SettingApplyMode;
  /** Present only for restart-required settings: the value currently in
   *  effect on the Data Plane listener. */
  readonly effective?: boolean | number | string;
}

export interface SettingsSnapshot {
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}

export type SettingsCommandOutcome =
  | "applied"
  | "pending"
  | "unknown_key"
  | "invalid_value";

export interface SettingsCommandResult {
  readonly outcome: SettingsCommandOutcome;
  readonly error?: string;
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}

export interface SettingsRegistry {
  /** Loads persisted and initial values once; idempotent. */
  load(): Promise<void>;
  catalog(): readonly RegisteredSetting[];
  query(keys: readonly string[]): Readonly<Record<string, RegisteredSetting>>;
  validate(
    key: string,
    value: unknown,
  ): { readonly valid: boolean; readonly error?: string };
  set(
    key: string,
    value: unknown,
    token: unknown,
  ): Promise<SettingsCommandResult>;
  snapshot(): SettingsSnapshot;
}

export interface SettingsStore {
  load(): Promise<Record<string, unknown>>;
  save(settings: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface SettingsRegistryOptions {
  /** Bootstrap values become the initial effective values for valid
   * registered keys that have no persisted value. */
  readonly initial?: Readonly<Record<string, unknown>>;
}

interface SettingDefinition {
  readonly key: string;
  readonly type: SettingType;
  readonly default: boolean | number | string;
  readonly validation: SettingValidation;
  readonly sensitivity: SettingSensitivity;
  readonly applyMode: SettingApplyMode;
}

function validateValue(
  definition: SettingDefinition,
  value: unknown,
): { readonly valid: boolean; readonly error?: string } {
  if (typeof value !== definition.type) {
    return {
      valid: false,
      error: `${definition.key} must be a ${definition.type}`,
    };
  }
  if (definition.validation.type === "integer") {
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < definition.validation.minimum ||
      (value as number) > definition.validation.maximum
    ) {
      return {
        valid: false,
        error: `${definition.key} must be an integer between ${definition.validation.minimum} and ${definition.validation.maximum}`,
      };
    }
    return { valid: true };
  }
  return { valid: true };
}

function settingFromDefinition(
  definition: SettingDefinition,
  current: boolean | number | string | undefined,
  effective: boolean | number | string | undefined,
): RegisteredSetting {
  return Object.freeze({
    key: definition.key,
    type: definition.type,
    default: definition.default,
    validation: Object.freeze({ ...definition.validation }),
    sensitivity: definition.sensitivity,
    applyMode: definition.applyMode,
    value: current ?? definition.default,
    ...(definition.applyMode === "restart-required"
      ? {
          effective: effective ?? current ?? definition.default,
        }
      : {}),
  });
}

const definitions: readonly SettingDefinition[] = Object.freeze([
  Object.freeze({
    key: "protocols.anthropic-messages.enabled",
    type: "boolean",
    default: true,
    validation: Object.freeze({ type: "boolean" }),
    sensitivity: "public",
    applyMode: "hot-apply",
  }),
  Object.freeze({
    key: "protocols.openai-responses.enabled",
    type: "boolean",
    default: true,
    validation: Object.freeze({ type: "boolean" }),
    sensitivity: "public",
    applyMode: "hot-apply",
  }),
  Object.freeze({
    key: "diagnostics.deepCapture.enabled",
    type: "boolean",
    default: false,
    validation: Object.freeze({ type: "boolean" }),
    sensitivity: "public",
    applyMode: "hot-apply",
  }),
  Object.freeze({
    key: "server.port",
    type: "number",
    default: 3000,
    validation: Object.freeze({ type: "integer", minimum: 1, maximum: 65_535 }),
    sensitivity: "public",
    applyMode: "restart-required",
  }),
  Object.freeze({
    key: "application.quitDrainTimeoutMs",
    type: "number",
    default: 5000,
    validation: Object.freeze({
      type: "integer",
      minimum: 0,
      maximum: 300_000,
    }),
    sensitivity: "public",
    applyMode: "hot-apply",
  }),
]);

const allKeys = Object.freeze(definitions.map((definition) => definition.key));

export function createSettingsRegistry(
  store: SettingsStore,
  options: SettingsRegistryOptions = {},
): SettingsRegistry {
  const definitionsByKey = new Map(
    definitions.map((definition) => [definition.key, definition]),
  );
  const persisted = new Map<string, boolean | number | string>();
  const pending = new Map<string, boolean | number | string>();
  // Effective values start at the declared defaults: before any restart a
  // restart-required setting is in effect with its default, never with a
  // pending value.
  const effective = new Map<string, boolean | number | string>(
    definitions.map((definition) => [definition.key, definition.default]),
  );
  let loaded = false;

  const definitionsFor = (key: string): SettingDefinition | undefined =>
    definitionsByKey.get(key);

  const currentSettings = (
    keys: readonly string[],
  ): Readonly<Record<string, RegisteredSetting>> => {
    const result: Record<string, RegisteredSetting> = Object.create(null);
    for (const key of keys) {
      const definition = definitionsFor(key);
      if (definition === undefined) continue;
      result[key] = settingFromDefinition(
        definition,
        pending.get(key) ?? effective.get(key),
        effective.get(key),
      );
    }
    return Object.freeze(result);
  };

  const snapshot = (): SettingsSnapshot =>
    Object.freeze({ settings: currentSettings(allKeys) });

  const persist = async (key: string, value: boolean | number | string) => {
    persisted.set(key, value);
    const raw: Record<string, unknown> = Object.create(null);
    for (const [persistedKey, persistedValue] of persisted) {
      raw[persistedKey] = persistedValue;
    }
    await store.save(raw);
  };

  const load = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    const stored = await store.load();
    for (const [key, value] of Object.entries(stored)) {
      const definition = definitionsFor(key);
      if (definition === undefined) continue;
      if (!validateValue(definition, value).valid) continue;
      pending.set(key, value as boolean | number | string);
      effective.set(key, value as boolean | number | string);
      persisted.set(key, value as boolean | number | string);
    }
    for (const [key, value] of Object.entries(options.initial ?? {})) {
      const definition = definitionsFor(key);
      if (definition === undefined || persisted.has(key)) continue;
      if (!validateValue(definition, value).valid) continue;
      pending.set(key, value as boolean | number | string);
      effective.set(key, value as boolean | number | string);
      persisted.set(key, value as boolean | number | string);
    }
  };

  const registry: SettingsRegistry = {
    load,
    catalog(): readonly RegisteredSetting[] {
      return Object.freeze(
        definitions.map((definition) =>
          settingFromDefinition(
            definition,
            pending.get(definition.key) ?? effective.get(definition.key),
            effective.get(definition.key),
          ),
        ),
      );
    },
    query(keys: readonly string[]): Readonly<Record<string, RegisteredSetting>> {
      if (keys.length === 0) return currentSettings(allKeys);
      return currentSettings(keys);
    },
    validate(
      key: string,
      value: unknown,
    ): { readonly valid: boolean; readonly error?: string } {
      const definition = definitionsFor(key);
      if (definition === undefined) {
        return { valid: false, error: `${key} is not a registered setting` };
      }
      return validateValue(definition, value);
    },
    async set(
      key: string,
      value: unknown,
      token: unknown,
    ): Promise<SettingsCommandResult> {
      void token;
      await load();
      const definition = definitionsFor(key);
      if (definition === undefined) {
        return {
          outcome: "unknown_key",
          settings: currentSettings(allKeys),
        };
      }
      const validated = validateValue(definition, value);
      if (!validated.valid) {
        return {
          outcome: "invalid_value",
          ...(validated.error === undefined
            ? {}
            : { error: validated.error }),
          settings: currentSettings(allKeys),
        };
      }
      const typed = value as boolean | number | string;
      pending.set(key, typed);
      await persist(key, typed);
      if (definition.applyMode === "hot-apply") {
        effective.set(key, typed);
        return {
          outcome: "applied",
          settings: currentSettings(allKeys),
        };
      }
      return {
        outcome: "pending",
        settings: currentSettings(allKeys),
      };
    },
    snapshot,
  };
  return Object.freeze(registry);
}
