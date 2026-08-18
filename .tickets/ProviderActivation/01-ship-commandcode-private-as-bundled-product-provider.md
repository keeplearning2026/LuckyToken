# 01 — Ship CommandCode Private as a bundled product Provider

**What to build:** A fresh LuckyToken Backend automatically includes CommandCode Private as a product-bundled Provider. Users do not configure or install its npm package, while external user Provider Packages remain separately configurable.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Add RED-first certification proving a fresh Provider composition discovers `commandcode-private` without any user `providerPackages` entry.
- [ ] The shipped Backend resolves the bundled CommandCode package from its installed runtime dependency graph without user action.
- [ ] The bundled package uses the same LuckyToken Provider Package contract and Pi Provider registration path as other Provider Packages; no protocol or request path special-cases CommandCode.
- [ ] The bundled package specifier and `commandcode-private` Provider ID are reserved product identities and cannot be claimed by user configuration.
- [ ] Explicit user configuration of the bundled CommandCode package is rejected under the current contract; no migration, duplicate load, silent ignore, alias, or compatibility branch is added.
- [ ] Existing external/user Provider Package loading remains functional and separately classified.
- [ ] Release/package tests fail if the bundled package is absent or cannot create the CommandCode Provider.
