import type { EffectiveCatalogBaseline } from "@luckytoken/application-control-plane/control-plane";

/**
 * The exact pinned Pi implementation that LuckyToken's models.json schema
 * and effective catalog composition are compatible with (Ticket 09).
 *
 * This record is the single compatibility identity: the models.json schema
 * (`src/providers/models-json-schema.ts`) is extracted from the pinned
 * `model-config.ts`, and the effective composition
 * (`src/providers/effective-composition.ts`) mirrors the pinned
 * `provider-composer.ts` apply/upsert/override semantics. Test fixtures
 * identify this baseline instead of importing Pi implementation objects.
 */
export const PI_COMPATIBILITY_BASELINE: EffectiveCatalogBaseline =
  Object.freeze({
    package: "@earendil-works/pi-coding-agent",
    version: "0.84.1",
    schema: "pi-coding-agent-0.84.1-models-json-schema",
  });

/** Pinned Pi source locations that define the baseline behavior. */
export const PI_COMPATIBILITY_SOURCES: Readonly<{
  readonly modelConfig: string;
  readonly providerComposer: string;
  readonly modelRuntime: string;
  readonly resolveConfigValue: string;
}> = Object.freeze({
  modelConfig: "pi-agent/packages/coding-agent/src/core/model-config.ts",
  providerComposer:
    "pi-agent/packages/coding-agent/src/core/provider-composer.ts",
  modelRuntime: "pi-agent/packages/coding-agent/src/core/model-runtime.ts",
  resolveConfigValue:
    "pi-agent/packages/coding-agent/src/core/resolve-config-value.ts",
});
