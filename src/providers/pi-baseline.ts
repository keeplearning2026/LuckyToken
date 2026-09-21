import type { EffectiveCatalogBaseline } from "@token/application-control-plane/control-plane";

/**
 * The models.json/effective-catalog compatibility identity that Token
 * mirrors (Ticket 09).
 *
 * This record is the recorded `@earendil-works/pi-coding-agent` reference
 * identity for the schema and composition semantics below; it is not Token's
 * runtime Provider execution dependency. The models.json schema
 * (`src/providers/models-json-schema.ts`) is extracted from that tree's
 * `model-config.ts`, and the effective composition
 * (`src/providers/effective-composition.ts`) mirrors its
 * `provider-composer.ts` apply/upsert/override semantics. Test fixtures
 * identify this reference baseline instead of importing Pi implementation
 * objects.
 *
 * The checked-in `pi-agent/` tree is reference material only and has been
 * updated to the `0.86.1` snapshot. Runtime Provider execution uses the
 * separate npm package `@earendil-works/pi-ai@0.86.1`. Re-extracting this
 * identity from the updated tree is separate work owned by the
 * providers/models.json schema owner.
 */
export const PI_COMPATIBILITY_BASELINE: EffectiveCatalogBaseline =
  Object.freeze({
    package: "@earendil-works/pi-coding-agent",
    version: "0.84.2",
    schema: "pi-coding-agent-0.84.2-models-json-schema",
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
