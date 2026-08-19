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
  aliasKeyError,
  canonicalTargetKey,
  computeEffectiveAliasRegistry,
  deriveDefaultAliases,
  deriveDefaultModelNames,
  MAX_ALIAS_LENGTH,
  normalizeModelName,
  parseAliasTarget,
  type AliasCatalogTarget,
  type DefaultModelNameAllocation,
} from "./domain.js";
