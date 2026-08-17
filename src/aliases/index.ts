export {
  createAliasRegistryAuthority,
  type AliasCatalogFacts,
  type AliasRegistryAuthority,
  type AliasRegistryAuthorityOptions,
  type AliasRegistryFileSystem,
  type AliasRegistryLock,
  type AliasResolverSnapshot,
} from "./authority.js";
export { createAliasControlPlaneHandler } from "./control-plane.js";
export {
  CURATED_ALIAS_DEFAULTS_VERSION,
  curatedAliasDefaults,
} from "./defaults.js";
export {
  canonicalTargetKey,
  computeEffectiveAliasRegistry,
  MAX_ALIAS_LENGTH,
  parseAliasTarget,
  type CuratedAliasDefault,
} from "./domain.js";
