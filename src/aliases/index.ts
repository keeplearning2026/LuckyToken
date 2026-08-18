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
  generatedDefaultAlias,
  MAX_ALIAS_LENGTH,
  parseAliasTarget,
  type AliasCatalogTarget,
} from "./domain.js";
