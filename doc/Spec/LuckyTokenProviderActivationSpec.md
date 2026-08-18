# LuckyToken Provider Activation Specification v1.0

**Status:** ACCEPTED IMPLEMENTATION SPECIFICATION  
**Date:** 2026-08-17  
**Scope:** Provider discovery, Provider authentication, catalog availability, Backend/Data Plane lifecycle ownership, CommandCode Private product bundling, Provider product UI, and release certification  
**Related specifications:**

- [LuckyToken Electron Product Architecture Specification](./LuckyTokenElectronArchitectureSpec.md)
- [LuckyToken Core Architecture Specification](./LuckyTokenCoreSpec.md)
- [Repository architecture rules](../../AGENTS.md)

This specification fixes the current product-level Provider activation gap without changing LuckyToken protocol semantics.

The existing Core boundary remains authoritative:

```text
Client Wire ↔ Client Protocol adapter ↔ Pi AI IR ↔ Pi Provider ↔ Upstream Wire
```

The problem addressed here is not protocol conversion. The current Electron product can start, render pages, and expose typed management APIs, but Provider discovery/authentication is coupled to the HTTP Data Plane lifetime. In a fresh or failed/stopped Gateway state the user therefore cannot reliably discover or log in to Providers. In addition, the shipped `@luckytoken/provider-commandcode-private` package is installed in the release Backend but is not part of the default product Provider composition.

The target product must make Provider activation a Backend capability that is available before and independently of the HTTP Data Plane.

---

# 1. Product outcome

A fresh installed LuckyToken must support this flow without editing configuration files:

```text
Launch LuckyToken
      ↓
Open Providers
      ↓
See every Pi built-in Provider
      +
See CommandCode Private
      ↓
Choose a Provider
      ↓
Run the Provider-owned login flow
      ↓
Credential persists in the existing Pi-compatible credential store
      ↓
Catalog/model availability refreshes
      ↓
Provider shows connected / usable models
      ↓
Every model already has default alias providerId/modelId
      ↓
Optionally add/edit one friendly alias on the model row
      ↓
Start or restart the Data Plane if needed
      ↓
Send a real request
      ↓
Observe it in Activity
```

The following must remain true while the Data Plane is `stopped` or `failed`:

- Provider discovery works;
- Provider authentication query works;
- Provider login works;
- credential status works;
- catalog query works;
- model availability facts remain queryable;
- CommandCode Private remains visible;
- Pi built-in Providers remain visible.

A port conflict or stopped Gateway must not remove the user's ability to configure the Provider that is required to make the product usable.

---

# 2. Confirmed current defects

## 2.1 CommandCode Private is packaged but not activated by the product

The release assembly installs `@luckytoken/provider-commandcode-private`, but the first-run configuration does not configure that package and the current Provider package loader only loads entries present in `config.providerPackages`.

Therefore a fresh product installation can contain the package on disk while never registering its Provider with Pi Models.

This is a product composition defect.

## 2.2 Provider management is currently coupled to Data Plane startup

`src/application.ts` currently creates `createConfiguredLuckyTokenComposition()` inside `DataPlaneRuntimeSupervisor.startListener()`.

Only after the HTTP Data Plane composition is created does the application assign:

```ts
credentialAuthority = composition.credentialAuthority;
authModels = composition.catalog.models;
```

The Auth Control Plane handler therefore receives optional functions:

```ts
models: () => Models | undefined;
authority: () => LiveCredentialAuthority | undefined;
```

When the Data Plane has not successfully started, Auth query/login returns `unavailable` even though authentication is logically a Backend management capability.

This is an ownership/lifecycle defect.

## 2.3 Catalog lifecycle is also tied to the Data Plane

The application currently binds the catalog refresh controller inside `startListener()`:

```ts
await catalogController.bind(composition.catalog, shutdownController.signal);
```

Stopping the Data Plane aborts that signal and therefore tears down the same runtime handle the Provider UI depends on.

Provider/model management must instead use Backend lifetime.

## 2.4 The existing Login implementation is reusable

The following existing components are directionally correct and are retained:

- Pi `Models.login()` as the Provider-owned authentication operation;
- `createAuthLoginControlPlaneHandler()` as the Auth command adapter;
- typed Auth interaction events (`auth_url`, `device_code`, `progress`, `prompt`, `info`);
- the one Pi-compatible credential store;
- `LiveCredentialAuthority` as the sanitized credential status/mutation authority;
- `CatalogRefreshController` as the catalog refresh/snapshot owner;
- `ProvidersPage` using typed Auth and Catalog commands;
- CommandCode Private declaring its own API-key login metadata and prompt.

The implementation must repair ownership around these capabilities, not reimplement them.

---

# 3. Goals

This work has eight goals.

## 3.1 Provider activation is a Backend-lifetime capability

Provider composition, credential status, login, and catalog availability exist for the lifetime of the Backend Application.

They do not start and stop with the HTTP listener.

## 3.2 Pi remains the authoritative Provider catalog

LuckyToken does not maintain a second hardcoded list of Pi Providers.

The current pinned Pi runtime remains the source of truth:

```ts
builtinProviders()
```

When Pi adds or removes a built-in Provider, LuckyToken Provider discovery follows automatically after the Pi version is intentionally upgraded.

## 3.3 CommandCode Private is a LuckyToken bundled Provider

`CommandCode Private` is automatically present in the installed product.

A user must not need to know the npm package name or add it to `providerPackages`.

## 3.4 One Pi Models collection serves Login and requests

There is one authoritative `Models` collection for Provider/model/auth behavior during one Backend lifetime.

The Auth path and Data Plane path use the same object graph.

## 3.5 Existing authorities retain their ownership

This work must not create a new generic state manager.

- Credential Authority continues to own credential facts;
- Catalog controller continues to own catalog refresh/snapshot facts;
- ModelsJson Authority continues to own `models.json` mutation;
- Alias Authority continues to own aliases;
- Runtime Supervisor continues to own Data Plane lifecycle;
- Application Control Plane only projects/invokes those owners;
- Renderer remains presentation/interaction state only.

## 3.6 Provider UI is generic

Renderer code must not special-case Provider IDs to implement authentication behavior.

Authentication buttons and labels come from Pi Provider metadata through the Backend projection.

## 3.7 Product completion is proven through real activation

A release-blocking deterministic product test must prove Provider discovery, login, model availability, Data Plane use, and Activity visibility through the packaged Electron product.

## 3.8 Every catalog model always has one effective alias

Every model in the authoritative active Catalog has exactly one effective external alias before the user configures anything.

The system-generated default is:

```text
providerId/modelId
```

For example:

```text
anthropic/claude-sonnet-4-6
commandcode-private/deepseek/deepseek-v4-flash
```

The canonical Provider/model target is an internal routing fact. The product UI must not ask the user to create or understand that mapping.

A user may replace the generated default with one custom alias. Removing the custom override restores the generated default automatically.

---

# 4. Non-goals

The following are explicitly outside this specification unless they are required to complete the Provider activation flow:

- changing Anthropic protocol conversion;
- changing OpenAI Responses conversion;
- changing Pi AI IR semantics;
- changing CommandCode request/response conversion;
- redesigning retry semantics;
- redesigning the Request Ledger;
- redesigning Deep Diagnostics;
- changing Electron process topology;
- changing Local IPC framing/security;
- installer/signing/updater work;
- final visual design-system polish;
- adding a generic plugin marketplace;
- adding runtime Provider install/uninstall;
- adding a second Provider registry database;
- adding Provider-specific logic to the renderer;
- moving Alias ownership into the Provider module;
- supporting multiple simultaneous effective aliases for one canonical model;
- exposing canonical Provider/model target selection as a normal-user workflow;
- moving all Client Token lifecycle into this work.

This is an ownership correction plus the minimum product surface needed to activate Providers.

---

# 5. Fixed architectural decisions

## 5.1 Do not add a fifth product architecture layer

The Electron specification remains authoritative:

```text
Renderer
  ↓
Typed Preload
  ↓
Electron Main
  ↓
Application Control Plane
  ↓
Backend Application
  ↓
Core / Pi
```

`ProviderRuntime` introduced below is an **internal deep module of Backend Application**, not a new package-level product layer.

No new workspace package is required.

## 5.2 Do not create a `ProviderRegistry` authority

Provider identity and auth metadata already exist in Pi `Provider` objects.

Provider discovery must continue to come from:

```ts
models.getProviders()
```

LuckyToken only needs one small additional product fact: where a Provider identity came from.

That fact is represented by a source resolver, not by a duplicate registry of Provider objects.

## 5.3 Provider Runtime does not own the Control Plane

Provider Runtime exposes Provider-domain objects to the Backend composition root.

The Backend Application continues to wire those objects to Control Plane handlers.

Provider Runtime must not import Electron, preload, renderer, or Application Control Plane host code.

## 5.4 Data Plane receives minimum Provider facts

The Data Plane must not receive a broad mutable `ProviderRuntime` object merely for convenience.

It receives only the facts/operations it actually needs, principally:

```ts
models: Models
providerCredentialScrub: (value: string) => string
```

If implementation proves another Provider-domain operation is required, add the smallest explicit dependency rather than passing the whole runtime.

## 5.5 No compatibility path for old CommandCode package configuration

`@luckytoken/provider-commandcode-private` becomes a bundled product Provider.

It is no longer a user-installed Provider Package configuration entry.

If `providerPackages` contains the bundled CommandCode package specifier, configuration is rejected with a clear current-contract error.

Do not silently ignore it, merge it, or support dual configuration.

## 5.6 Existing Provider Package extension remains available for user packages

`config.providerPackages` continues to represent explicitly configured **external/user Provider Packages**.

The existing package contract and package loader are reused.

Bundled Providers and user Provider Packages are loaded as distinct sources so product origin remains unambiguous.

## 5.7 Default aliases are derived from the active Catalog, not a static curated table

LuckyToken must not maintain a hand-authored list of default aliases for selected models.

For every canonical Catalog target:

```ts
{ provider: providerId, model: modelId }
```

Alias Authority derives the default alias deterministically as:

```ts
`${providerId}/${modelId}`
```

This generated lower layer is not persisted. A new model automatically receives its default alias as soon as the authoritative Catalog snapshot contains it.

The existing static `curatedAliasDefaults` / `CURATED_ALIAS_DEFAULTS_VERSION` model is obsolete under this specification and should be removed rather than adapted.

## 5.8 User aliases are overrides of an already assigned model alias

A model never starts in an "unaliased" state.

The user-owned alias file stores only explicit custom overrides. A valid custom alias for a canonical target replaces that target's generated default in the effective registry.

There remains at most one effective alias per canonical target.

Conceptually:

```text
Catalog target
  commandcode-private + deepseek/deepseek-v4-flash
        ↓
generated default alias
  commandcode-private/deepseek/deepseek-v4-flash
        ↓ user chooses "flash"
user override
  flash → same internal target
        ↓
effective alias
  flash
```

Deleting/resetting that override makes the generated default effective again without writing a default mapping to disk.

---

# 6. Target runtime topology

The target Backend topology is:

```text
                         Backend Application
                                │
             ┌──────────────────┴──────────────────┐
             │                                     │
             ▼                                     ▼
     Provider Runtime                      Data Plane Supervisor
     Backend lifetime                      restartable lifetime
             │                                     │
     ┌───────┼────────┐                    ┌───────┴────────┐
     │       │        │                    │                │
   Models  Credential catalog handle     HTTP          Protocol handlers
     │     Authority      │                │                │
     │                    │                └──────┬─────────┘
     │                    │                       │
     └────────────────────┴───────────────────────┘
                     same Pi Models
```

Lifecycle:

```text
Backend starts
    ↓
create Provider Runtime
    ↓
Pi built-ins + bundled CommandCode + user Providers exist
    ↓
credential/auth query works
    ↓
bind CatalogRefreshController to Provider Runtime catalog handle
    ↓
start Control Plane
    ↓
Provider UI usable
    ↓
Data Plane may start / stop / fail / restart independently
```

A Data Plane restart must never reconstruct the Provider Runtime.

---

# 7. Provider Runtime module

## 7.1 Location

Target module:

```text
src/providers/runtime.ts
```

Supporting bundled metadata:

```text
src/providers/bundled.ts
```

Do not create `provider-runtime/` with many one-line wrappers unless implementation complexity genuinely requires more than these modules.

## 7.2 Responsibility

Provider Runtime owns exactly the Backend-lifetime Provider execution environment:

- creation of the one Pi `Models` collection;
- Pi built-in Provider registration;
- `models.json` Provider composition;
- bundled LuckyToken Provider Package loading;
- external user Provider Package loading;
- the one Pi-compatible credential store used by those Providers;
- `LiveCredentialAuthority` over that credential store;
- the existing catalog runtime handle (`models`, `recompose`, `capture`);
- Provider source classification.

It does **not** own:

- Application Control Plane host;
- Data Plane listener lifecycle;
- HTTP server;
- Client Protocol handlers;
- Alias Authority;
- Settings Registry;
- Request Ledger;
- History/Backup;
- Tray/Electron state;
- UI projections beyond source classification.

## 7.3 Target internal seam

The target seam is intentionally small:

```ts
export type ProviderSource =
  | "pi_builtin"
  | "luckytoken_bundled"
  | "user";

export interface ProviderRuntime {
  readonly models: Models;
  readonly credentialAuthority: LiveCredentialAuthority;
  readonly catalog: CatalogRuntimeHandle;
  providerSource(providerId: string): ProviderSource;
}
```

`CatalogRuntimeHandle` is the existing runtime handle shape already consumed by `CatalogRefreshController`:

```ts
interface CatalogRuntimeHandle {
  readonly models: Models;
  readonly recompose: (modelsJson: ModelsJsonConfig | undefined) => void;
  readonly capture: () => void;
}
```

No `start()`, `stop()`, event bus, command dispatcher, state store, or general-purpose service locator is added.

There is currently no Provider-owned resource requiring an independent close contract. If future Provider contracts acquire real closeable resources, add lifecycle only when that requirement exists.

## 7.4 Factory inputs

`createProviderRuntime()` should accept only Provider-domain dependencies.

Conceptually:

```ts
interface CreateProviderRuntimeOptions {
  readonly piDirectory: string;
  readonly modelsJsonPath: string;
  readonly userProviderPackages: Readonly<Record<string, unknown>>;
  readonly fetch: FetchFunction;
  readonly credentials?: CredentialStore;
  readonly modelsStore?: ModelsStore;
  readonly configValueAdapters?: ConfigValueAdapters;
  readonly authContext?: AuthContext;
  readonly importModule?: ImportProviderModule;
  readonly onInvalidModelsJson?: (error: unknown) => void;
  readonly onProviderLogin?: (providerId: string) => void;
  readonly createUuid?: () => string;
  readonly now?: () => number;
}
```

Exact existing type names should be reused where available.

Do not pass the whole `LuckyTokenCliConfig`; server ports, client protocols, diagnostics paths, and unrelated configuration do not belong to the Provider module.

---

# 8. Provider composition

## 8.1 Three product sources

Provider identities exposed to the product come from exactly three source classes:

```text
Pi built-in Provider
LuckyToken bundled Provider
User Provider
```

### Pi built-in

Source of truth:

```ts
builtinProviders()
```

Examples include Anthropic, OpenAI, OpenAI Codex, DeepSeek, GitHub Copilot, Google, OpenRouter, Groq, Mistral, and the rest of the pinned Pi catalog.

### LuckyToken bundled

V1 contains:

```text
CommandCode Private
```

The package implementation remains:

```text
@luckytoken/provider-commandcode-private
```

The npm/package identity is an implementation detail and is never required in normal UI or first-run configuration.

### User

A Provider identity is `user` when it is introduced by:

- a custom `models.json` Provider that is not a Pi built-in identity; or
- an external user Provider Package.

A `models.json` overlay of an existing Pi built-in Provider remains `pi_builtin` because the Provider identity originates from Pi; the user configuration is an overlay, not a new Provider identity.

## 8.2 Bundled Provider metadata

`src/providers/bundled.ts` owns only immutable product assembly metadata.

Conceptually:

```ts
interface BundledProviderPackage {
  readonly specifier: string;
  readonly providerId: string;
  readonly configuration: unknown;
}

export const bundledProviderPackages = Object.freeze([
  Object.freeze({
    specifier: "@luckytoken/provider-commandcode-private",
    providerId: "commandcode-private",
    configuration: Object.freeze({}),
  }),
]);
```

This metadata exists to:

- load the package automatically;
- reserve its package specifier;
- reserve its Provider ID;
- classify its product source;
- certify release assembly.

It is **not** a duplicate Provider catalog. Names, auth labels, models, and behavior still come from the Provider returned by the package.

## 8.3 Loading order

The composition order is:

```text
1. Pi built-ins
2. models.json overlays/custom Providers
3. LuckyToken bundled Provider Packages
4. external user Provider Packages
```

The existing Pi/models.json composition code remains the authority for steps 1 and 2.

The existing Provider Package loader remains the authority for package validation and package Provider creation.

Bundled and external packages must be loaded through the same `@luckytoken/provider-contract` package contract.

## 8.4 Collision rules

The following are forbidden:

- a user `models.json` Provider using a reserved bundled Provider ID;
- `providerPackages` containing a bundled package specifier;
- an external package returning a Provider ID already owned by a Pi built-in, models.json composition, or bundled Provider;
- two packages returning the same Provider ID.

Do not resolve collisions by precedence or silent override.

Fail with a clear configuration/product integrity error.

Pi built-in overlays through `models.json` remain the existing explicit exception because that is the designed models.json composition contract.

## 8.5 Release dependency requirement

The shipped Backend must be able to resolve every bundled Provider Package without user action.

For CommandCode Private this means the release assembly/package dependency graph must guarantee:

```text
@luckytoken/provider-commandcode-private
```

exists as a runtime dependency in the packaged Backend.

The exact npm workspace/dependency mechanism is implementation detail; release certification is authoritative.

---

# 9. Provider source projection

## 9.1 No duplicate registry

Provider source is a bounded metadata fact attached to the existing Auth Provider projection.

Add:

```ts
export type ProviderSource =
  | "pi_builtin"
  | "luckytoken_bundled"
  | "user";

export interface AuthProviderOption {
  readonly providerId: string;
  readonly name: string;
  readonly source: ProviderSource;
  // existing auth fields remain
}
```

Do not add a second `ProviderProjection` tree containing models/auth duplicated from Catalog and Credential projections.

## 9.2 Source resolver

Provider Runtime maintains only enough metadata to answer:

```ts
providerSource(providerId: string): ProviderSource
```

The resolver uses:

- a fixed set of Pi built-in IDs;
- fixed bundled Provider IDs;
- the current user Provider IDs from models.json/external packages.

When models.json is recomposed, the current user Provider ID set is updated in the same composition operation.

No renderer inference is allowed.

## 9.3 Source precedence

Classification is deterministic:

```text
bundled Provider ID   → luckytoken_bundled
Pi builtin Provider ID → pi_builtin
otherwise present user Provider → user
```

Bundled/Pi ID collisions are prohibited by construction, so the precedence is defensive rather than an override policy.

---

# 10. Credential ownership and Login

## 10.1 One credential store

Provider Runtime and Data Plane must use the same Pi-compatible credential store for one Backend lifetime.

There must never be:

```text
UI/Login auth.json
+
Data Plane auth.json
```

as separate authorities.

## 10.2 Credential Authority becomes Backend-lifetime

`LiveCredentialAuthority` is created when Provider Runtime is created.

It remains alive regardless of Data Plane status.

The Control Plane handlers receive it directly.

Target Auth handler construction:

```ts
const authCommandHandler = createAuthLoginControlPlaneHandler({
  models: providerRuntime.models,
  authority: providerRuntime.credentialAuthority,
  providerSource: providerRuntime.providerSource,
});
```

The existing optional normal-state dependencies are removed:

```ts
Models | undefined
LiveCredentialAuthority | undefined
```

Provider management unavailability is no longer a normal consequence of Gateway lifecycle.

## 10.3 Auth query behavior

`AuthCommand { command: "query" }` returns all Providers from:

```ts
providerRuntime.models.getProviders()
```

for every normal Backend state:

```text
Data Plane stopped
Data Plane starting
Data Plane running
Data Plane stopping
Data Plane failed
```

Each result carries:

- Provider ID;
- Provider name;
- Provider source;
- Provider-declared OAuth/account capability;
- Provider-declared subscription metadata;
- Provider-declared API-key capability;
- sanitized effective credential status.

## 10.4 Login behavior

Login continues to call:

```ts
providerRuntime.models.login(providerId, authType, interaction)
```

Provider-owned interaction remains authoritative.

The Backend does not duplicate OAuth/API-key rules.

CommandCode Private therefore uses the API-key prompt already declared by its Provider Package.

## 10.5 Login result and catalog refresh are distinct facts

Successful credential persistence and model/catalog refresh must not be collapsed into one boolean.

Correct state progression:

```text
login succeeds
    ↓
credential status = connected
    ↓
Provider Runtime schedules catalog refresh for that Provider
    ↓
catalog status/model availability updates independently
```

If credential persistence succeeds but catalog refresh fails, UI must show both facts:

```text
Connected
Models could not be refreshed
[ Retry models ]
```

It must not revert to `Not connected`.

## 10.6 Login while Data Plane is stopped

This sequence is mandatory:

```text
Backend running
Data Plane stopped
      ↓
login CommandCode Private
      ↓
credential persisted
      ↓
start Data Plane
      ↓
first request uses that credential
```

No application restart is permitted between these steps.

---

# 11. Catalog lifecycle

## 11.1 Catalog controller remains an Application-owned Provider capability

Do not move `CatalogRefreshController` into a new generalized runtime manager.

`src/application.ts` continues to create it because it already coordinates:

- ModelsJson Authority;
- catalog cache store;
- diagnostics;
- alias invalidation;
- status publication.

The lifecycle correction is simply that it binds to Provider Runtime **before Data Plane startup**.

## 11.2 Target startup order

Normal application startup becomes:

```text
open diagnostics / ledger / capture
      ↓
create ModelsJson Authority
create Catalog Cache
create Settings Registry
      ↓
create CatalogRefreshController
      ↓
create Provider Runtime
  ↳ onProviderLogin → catalogController.onProviderLogin
      ↓
bind catalogController(providerRuntime.catalog)
      ↓
create Alias Authority from catalogController snapshot
      ↓
create Auth/Credential/Catalog Control Plane handlers
      ↓
create Data Plane Supervisor
      ↓
start Control Plane
      ↓
start Data Plane
```

The catalog bind uses Backend lifetime.

It must not be bound to a Data Plane shutdown signal.

Application shutdown calls:

```ts
catalogController.dispose()
```

which already aborts active refresh work.

## 11.3 Catalog while Data Plane is stopped

`CatalogCommand query` must always return the current Provider Runtime catalog snapshot in normal Backend mode.

`CatalogCommand refresh` must remain usable while the Data Plane is stopped.

The catalog is about Provider/model capability, not HTTP listener state.

## 11.4 Catalog snapshot and request consistency

Existing snapshot semantics remain unchanged:

```text
Request A captures Model object
      ↓
login / catalog refresh / recompose occurs
      ↓
Request A continues with captured facts
      ↓
Request B begins after capture
      ↓
Request B uses new catalog facts
```

Do not mutate Model objects already captured by in-flight requests.

## 11.5 Alias defaults are generated from canonical Catalog targets

Alias Authority continues to belong to Backend Application, but its lower layer is no longer a static curated table.

The Catalog snapshot already owns the authoritative canonical model set. Alias Authority receives the minimum canonical facts required to derive aliases.

Preferred fact shape:

```ts
interface AliasCatalogFacts {
  readonly catalogVersion: number;
  readonly targets: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
}
```

The implementation may use an equivalent immutable shape, but it must not maintain both `targets` and a separately authoritative hand-built default alias list.

For each target, the generated default alias is exactly:

```ts
`${target.provider}/${target.model}`
```

Alias text is opaque external identity. It may contain multiple `/` characters. A model id such as:

```text
deepseek/deepseek-v4-flash
```

therefore produces:

```text
commandcode-private/deepseek/deepseek-v4-flash
```

The implementation must never parse this generated alias string to reconstruct canonical identity. The canonical target is carried explicitly as `{ provider, model }`.

## 11.6 User override replaces the generated alias for that model

The existing invariant remains:

> at most one effective alias per canonical target.

User mappings are evaluated before generated defaults.

A valid user mapping claims its canonical target. When the generated-default pass reaches an already claimed target, it **skips that generated default**. This is the normal override path and is not a `duplicate` validation error.

Example:

```text
catalog target
  { provider: "anthropic", model: "claude-sonnet-4-6" }

system default
  anthropic/claude-sonnet-4-6

user override
  sonnet → same target

result
  effective alias = sonnet
  anthropic/claude-sonnet-4-6 is not simultaneously effective
```

A custom alias that collides with the effective alias of a different target is rejected. The authority never guesses which model should win.

## 11.7 `model-aliases.json` stores overrides only

The transparent user file continues to persist only explicit user choices.

Generated defaults are derived state and never written to disk.

Therefore:

```text
no user override
→ no file entry required
→ catalog-derived default is effective
```

and:

```text
custom override deleted/reset
→ user entry removed
→ catalog-derived default immediately becomes effective again
```

No migration or compatibility layer is required for the old curated default set.

If an externally edited user file is malformed, current fail-closed file behavior remains: invalid user data does not replace the last safe behavior, and Catalog-derived defaults remain derivable from authoritative Catalog facts.

If a model temporarily leaves the active Catalog, its generated default naturally disappears. A valid persisted user override may remain configured against that canonical target so existing `model_unavailable` behavior can report the target as unavailable; if the model returns, the custom alias becomes usable again without rewriting the file.

## 11.8 Static curated defaults are removed

The current implementation symbols:

```text
curatedAliasDefaults
CURATED_ALIAS_DEFAULTS_VERSION
```

and the static selected-model default table are obsolete.

`defaultsVersion` is also redundant once defaults are a pure function of `catalogVersion + canonical targets`; remove that field from Alias domain/Control Plane state if no independent meaning remains after implementation.

Do not keep a second defaults generation counter merely for compatibility with the old design.

---

# 12. `models.json` recomposition

## 12.1 One recomposition operation

Provider Runtime owns the existing relation between:

- Pi Provider composition;
- parsed models.json Provider facts;
- Credential Authority models.json classification;
- Provider source classification.

When the catalog handle receives:

```ts
recompose(nextModelsJson)
```

that one operation must update all Provider Runtime metadata derived from the same models.json generation before the next capture.

Conceptually:

```text
models.json next generation
      ↓
recompose Pi Providers
      ↓
update Credential Authority modelsJson source view
      ↓
update current user Provider ID set
      ↓
capture new catalog
```

No module independently reparses models.json for this purpose.

## 12.2 Reserved bundled Provider IDs

A models.json Provider with ID:

```text
commandcode-private
```

is invalid under this specification.

Bundled Provider identity is product-owned and cannot be replaced by models.json.

---

# 13. Data Plane composition

## 13.1 Rename/split the current broad composition

The existing `createConfiguredLuckyTokenComposition()` currently mixes Provider-domain creation with Data Plane creation.

The target is to separate the Provider portion into `createProviderRuntime()` and make the remaining function explicitly a Data Plane composition.

Preferred target name:

```ts
createConfiguredLuckyTokenDataPlane(...)
```

No compatibility alias is required for the old internal function name.

## 13.2 Data Plane inputs

The Data Plane composition receives the already-created Provider models.

Conceptually:

```ts
interface ConfiguredLuckyTokenDataPlaneOptions {
  readonly config: LuckyTokenCliConfig;
  readonly models: Models;
  readonly providerCredentialScrub: (value: string) => string;
  // existing Data Plane-specific dependencies:
  // diagnostics, request ledger, capture, settings,
  // aliases, client tokens, Codex native seams, etc.
}
```

Do not pass the whole Provider Runtime when only these facts are required.

## 13.3 Data Plane must not create Providers

The target Data Plane composition must not call:

```text
createModels
builtinProviders
loadProviderPackages
createLiveCredentialAuthority
createCatalogRefreshController
```

Provider/model/auth creation belongs exclusively to Provider Runtime / Backend Application.

## 13.4 Data Plane restart invariant

A stop/start/restart of the Runtime Supervisor creates a new HTTP/protocol serving composition but reuses:

```text
providerRuntime.models
providerRuntime credential scrub function
```

The Provider Runtime object identity must remain unchanged across Data Plane restarts.

---

# 14. Application status semantics

## 14.1 Correct the meaning of `ApplicationStatus.provider`

The current implementation marks Provider `configured` when provider-related config exists. That does not describe product usability.

Under this specification:

```text
provider = "configured"
```

means:

> at least one model in the current authoritative catalog is available for use under current Provider authentication.

Otherwise:

```text
provider = "unconfigured"
```

This remains a coarse Home/Tray readiness summary only.

Detailed facts remain in Auth/Credential/Catalog projections.

## 14.2 Pure derivation

Add one pure helper conceptually equivalent to:

```ts
function providerReadiness(
  snapshot: CatalogSnapshotProjection,
): "configured" | "unconfigured" {
  return snapshot.providers.some((provider) =>
    provider.models.some((model) => model.availability === "available"),
  )
    ? "configured"
    : "unconfigured";
}
```

Do not maintain a second mutable Provider-ready boolean.

## 14.3 Status publication

When a catalog snapshot changes, Backend Application:

1. recomputes the coarse Provider readiness from the snapshot;
2. updates the latest application status with that readiness;
3. triggers existing Alias catalog invalidation;
4. republishes through the existing Control Plane status path.

The Catalog controller remains the source of detailed model availability.

---

# 15. Control Plane contract changes

## 15.1 Add Provider source to Auth option

Add the source enum and `AuthProviderOption.source`.

Update strict wire encode/decode tests.

No new Provider-list command is introduced.

`AuthCommand query` remains the one Provider authentication/discovery product query.

## 15.2 Keep existing Auth commands

Do not add Provider-specific commands.

Retain:

```ts
{ command: "query" }
{ command: "login", providerId, authType }
```

Logout remains on the existing Credential command seam.

## 15.3 Keep existing Catalog commands

Retain:

```ts
{ command: "query" }
{ command: "refresh", mode: "background" | "manual" }
```

The behavioral change is lifecycle availability, not a new command vocabulary.

## 15.4 No generic Provider DTO

Do not add:

```text
DesktopProvider
ElectronProvider
ProviderViewModel wire DTO
ProviderRegistrySnapshot
```

Auth projection + Catalog projection + Credential status already contain the required facts.

## 15.5 Add model-scoped alias mutation commands for product UI

The normal product UI must not construct or replace the entire `model-aliases.json` mapping record just to rename one model.

Extend the existing Alias Control Plane contract with the smallest target-scoped mutations, conceptually:

```ts
{ command: "set_for_model", revision, providerId, modelId, alias }
{ command: "reset_for_model", revision, providerId, modelId }
```

Exact field naming may follow existing contract conventions, but the semantics are fixed:

- `set_for_model` replaces the one user override for that canonical target;
- `reset_for_model` removes the user override for that target so the generated `providerId/modelId` alias becomes effective again;
- both are compare-and-swap mutations against the Alias Authority revision;
- both validate the canonical target against current Catalog facts;
- neither exposes raw file mutation to the Renderer.

The existing bulk `write` command may remain for Advanced/manual management if still required, but `ProvidersPage` must use the model-scoped operation.

This is not a second Alias authority. It is a narrower command vocabulary over the existing one.

---

# 16. Providers product UI

## 16.1 Product responsibility

`ProvidersPage` is the primary activation surface.

It must let a normal user discover and authenticate Providers without editing files.

## 16.2 Initial query

On mount, query independently:

```text
Auth query
Catalog query
```

An Auth query failure must render an explicit Provider management error state.

It must never render an empty Provider list and imply that no Providers exist when the real failure is Control Plane/Auth unavailability.

## 16.3 Provider list organization

V1 should use a simple product organization, not forty unstructured cards:

```text
Providers
[ Search providers… ]

Connected
  ...

Available
  ...
```

A later category/filter system is not required for P0.

## 16.4 Generic Provider card

A Provider card may display:

```text
Provider name
source label
credential state
known/available model count
authentication actions
catalog failure/retry state
```

Source labels are derived from `source`:

```text
pi_builtin           → Built in
luckytoken_bundled   → LuckyToken
user                 → Custom
```

These are presentation labels only.

## 16.5 Auth actions

Buttons are entirely driven by Provider metadata:

```text
account === true  → account/OAuth button
apiKey === true   → API-key button
```

Use Provider-declared labels when present.

No logic such as this is allowed:

```ts
if (provider.providerId === "anthropic") { ... }
if (provider.providerId === "commandcode-private") { ... }
```

Provider-specific protocol steps stay inside Pi Provider auth implementations.

## 16.6 Connected state

For product presentation, an effective auth source that is not expired/unavailable is connected.

Credential state and model state remain visibly separate.

Examples:

```text
CommandCode Private
LuckyToken
Connected
3 models available
[ Reconnect ]
```

and:

```text
CommandCode Private
LuckyToken
Connected
Model refresh failed
[ Retry models ]
```

## 16.7 Login interaction

The existing typed interaction UX is retained:

- secret/text/manual-code/select prompts;
- browser URL;
- device code;
- progress information;
- cancellation.

Secret values remain one-shot interaction input and must never be stored in renderer state beyond the active prompt lifetime or returned in projections.

## 16.8 Catalog updates after login

Backend login success schedules the existing provider-specific catalog refresh.

`ProvidersPage` must observe the existing status/catalog version lifecycle so it can re-query catalog facts when the authoritative version changes.

Do not invent a second Renderer-side refresh timer.

A direct query immediately after login is allowed for responsiveness, but authoritative convergence is driven by Backend catalog version changes.

## 16.9 Search

Search is Renderer-owned ephemeral state.

It filters only currently projected Provider cards by safe fields such as Provider display name/ID.

It is not persisted and does not alter Backend Provider state.

## 16.10 Model rows expose alias as a model action, not a routing editor

A connected/known Provider may expand or otherwise expose its projected model rows.

Each model already has an effective alias. The product UI does **not** present a separate "Provider/model target" field or ask the user to create a mapping.

For a model using its generated default, the row may conceptually look like:

```text
DeepSeek V4 Flash
Alias: commandcode-private/deepseek/deepseek-v4-flash        [ + alias ]
```

The icon/action is product-language **Add alias**: the user is adding a friendly name to the model. Internally this is an override of the already assigned default alias, not creation of a second effective alias.

Clicking it opens a small model-scoped editor such as:

```text
Add alias

Model
DeepSeek V4 Flash

Current alias
commandcode-private/deepseek/deepseek-v4-flash

Custom alias
[ flash________________ ]

[ Cancel ]  [ Save ]
```

There is no Provider selector, model selector, canonical-target editor, or raw JSON on this normal product surface. The model row already determines the target.

After a custom alias is saved:

```text
DeepSeek V4 Flash
Alias: flash                                             [ edit alias ]
```

The same icon may change tooltip/accessible label from `Add alias` to `Edit alias`; this is presentation only.

The editor also offers a small `Use default` / reset action when a custom override exists. Reset removes the user override and restores:

```text
providerId/modelId
```

The Renderer sends only the model identity already present in Catalog projection plus the requested alias mutation through the typed Alias command. It never derives file structure or chooses a target independently.

## 16.11 Effective alias is the client-visible model identity

For alias-only LuckyToken client paths, `/v1/models`, Codex catalog generation, and model selection use the one effective alias from Alias Authority.

Therefore:

```text
no override
→ client-visible model = providerId/modelId

custom override "flash"
→ client-visible model = flash
```

The canonical Provider/model identity remains internal routing state even though the generated default alias happens to contain the same textual components.

Do not add UI copy explaining canonical mapping mechanics to normal users.

---

# 17. Home and Connect integration

## 17.1 Home

Home continues to use the coarse `ApplicationStatus.provider` readiness summary.

Fresh product with no usable Provider:

```text
Connect an AI provider
[ Set up provider ]
```

After Provider auth/model availability becomes usable:

```text
Provider ready
Next: connect a client
```

Gateway state remains independently visible.

## 17.2 Do not make Gateway the prerequisite for Login

A stopped/failed Gateway may still show a Gateway action on Home, but it cannot block navigation to Providers or Provider login.

## 17.3 Connect

Connect may continue to require a usable Provider before configuring a client.

Its prerequisite reads the corrected Provider readiness summary, not presence of `providerPackages`/models.json configuration.

---

# 18. Failure semantics

## 18.1 Bundled Provider package missing/broken

Failure to load a required bundled Provider is a product installation/integrity failure.

Do not silently run a degraded product that claims CommandCode is part of the product while omitting it.

Release certification should make this impossible in normal shipped builds.

## 18.2 External user Provider Package failure

Keep the current strict Provider Package failure contract unless a separate product requirement changes it.

This specification does not introduce package isolation/fallback semantics.

## 18.3 Credential file invalid

`LiveCredentialAuthority` continues to project its existing sanitized invalid-file state.

Provider identities can still be known from Pi/Provider composition, but login/mutation behavior follows existing safe credential authority rules.

Do not leak file contents or secrets.

## 18.4 Data Plane port conflict

A port conflict only changes:

```text
modelDataPlane = failed
DataPlaneFailure = port_in_use
```

It must not make Auth or Catalog commands unavailable.

## 18.5 Catalog refresh failure

Catalog refresh failure is Provider/model availability information.

It does not roll back a successfully stored credential.

## 18.6 Auth cancellation/failure

Existing value-safe Auth outcomes remain:

```text
cancelled
failed
conflict
unknown_provider
unsupported
storage_failure
```

Raw Provider error bodies and credentials do not cross the Control Plane.

---

# 19. Concurrency and consistency invariants

## 19.1 Login and request concurrency

Provider Runtime is shared by management and request paths.

The implementation must prove that concurrent login/catalog refresh does not mutate facts already captured by an in-flight request.

Required invariant:

```text
Request A accepted with catalog generation N
Login / refresh publishes generation N+1
Request A completes with generation N facts
Request B accepted afterwards uses generation N+1
```

## 19.2 Credential replacement

Pi credential store/authority serialization remains the single credential mutation mechanism.

No additional renderer/main-process credential cache is introduced.

## 19.3 Catalog serialization

Continue using the existing CatalogRefreshController queue/snapshot mechanism.

Do not add a second refresh mutex in Provider Runtime.

## 19.4 models.json recompose

A recompose and the corresponding Provider source metadata update are one logical operation before capture for subsequent requests.

## 19.5 Data Plane restart

Provider Runtime object identity remains constant while Data Plane serving composition identity changes.

This must be directly asserted in an application/integration test.

---

# 20. Security and information boundaries

The existing security model remains.

## 20.1 Credential values

Credential values belong to the Backend credential store/Provider login flow.

They never appear in:

- Auth option projections;
- Catalog projections;
- status snapshots;
- Tray state;
- persistent renderer state.

## 20.2 Provider package identity

The internal npm package name of CommandCode Private does not need to cross the Control Plane.

The UI sees Provider identity/name/source only.

## 20.3 Renderer

Renderer cannot import Pi, Provider packages, Node, or Electron.

It does not inspect auth files, models.json, or environment variables.

## 20.4 Electron Main

Electron Main remains unaware of Provider semantics.

It only transports typed Desktop API operations to the Control Plane.

---

# 21. File-level target map

The intended changes are concentrated and should not cause unrelated refactors.

| Current/target file | Target responsibility/change |
|---|---|
| `src/providers/runtime.ts` | new internal Provider Runtime factory; one Pi Models + Credential Authority + catalog handle + source resolver |
| `src/providers/bundled.ts` | immutable bundled package metadata/reserved IDs; CommandCode Private product bundling |
| `src/providers/catalog.ts` | retain Pi builtin + models.json composition; add only reserved-ID hook if required, do not become product UI registry |
| `src/providers/package-loader.ts` | retain Provider Package validation/loading; reused separately for bundled and external packages |
| `src/composition.ts` | remove Provider creation from broad Data Plane composition; move provider-specific creation into Provider Runtime; Data Plane consumes injected Models/minimum scrub fact |
| `src/application.ts` | create Provider Runtime and bind Catalog before Data Plane Supervisor; Control Plane Auth/Credential/Catalog always wired to Backend-lifetime authorities |
| `src/credentials/login-control-plane.ts` | require non-optional Models/Credential Authority; project Provider source; retain Pi-owned login flow |
| `src/credentials/auth-options.ts` | add generic Provider source projection; no Provider ID special cases |
| `src/aliases/defaults.ts` | delete the static curated default table; defaults are generated from Catalog targets |
| `src/aliases/domain.ts` | derive `provider/modelId` defaults for every Catalog target; valid user override claims a target and suppresses its generated default |
| `src/aliases/authority.ts` | consume canonical Catalog targets; persist overrides only; add target-scoped set/reset mutation over the existing CAS/file authority |
| `packages/application-control-plane/src/contracts.ts` | add `ProviderSource` / `AuthProviderOption.source`; update Alias default semantics and add model-scoped set/reset commands; remove obsolete `defaultsVersion` if no longer meaningful |
| `packages/application-control-plane/src/wire.ts` | strict Provider-source and model-scoped Alias command decoding/encoding certification |
| `packages/desktop-shell/src/renderer/providers/ProvidersPage.tsx` | real Provider discovery/login product workflow, search/grouping, model rows, Add/Edit alias action, separate auth/catalog state |
| `packages/desktop-shell/src/renderer/home/HomePage.tsx` | consume corrected coarse Provider readiness; no Provider-specific logic |
| release assembly/certification | guarantee bundled CommandCode package resolution and product discovery |

The implementation may choose nearby filenames where existing cohesion is stronger, but the ownership rules in this specification are fixed.

---

# 22. Explicit deletions / simplifications

After the new seam is proven, remove obsolete normal-state patterns rather than retaining them.

Delete or replace:

```text
application authModels: Models | undefined
application credentialAuthority: LiveCredentialAuthority | undefined
Auth handler normal-state `unavailable` caused by Data Plane not started
catalog bind inside Data Plane startListener
Provider configured status derived from config.providerPackages presence
CommandCode Private user configuration requirement
static curated Alias defaults / defaults generation counter
normal-product whole-file Alias editing for one-model rename
Data Plane Provider/credential/catalog creation path
```

Do not leave a legacy `createConfiguredLuckyTokenComposition()` path that can still create a second Pi Models collection in production.

No compatibility wrapper is required.

---

# 23. TDD certification plan

Implementation starts by making the following tests fail for the current product.

## 23.1 Provider Runtime contract tests

### P1 — Pi built-in discovery

Given a Provider Runtime with no user models.json Providers and no external packages:

```ts
actualPiBuiltinIds === builtinProviders().map(p => p.id)
```

Compare normalized sets/IDs, not a hand-maintained Provider list.

### P2 — bundled CommandCode discovery

Without any user `providerPackages` configuration:

```text
models.getProvider("commandcode-private") exists
source = luckytoken_bundled
models count > 0
```

### P3 — source classification

Prove:

```text
Pi builtin → pi_builtin
CommandCode → luckytoken_bundled
custom models.json Provider → user
external package Provider → user
```

and a models.json overlay of a Pi built-in remains `pi_builtin`.

### P4 — reserved bundled identities

Prove user configuration cannot claim bundled package specifier or bundled Provider ID.

## 23.2 Backend lifecycle tests

### B1 — Auth query while Data Plane stopped

```text
Backend running
Data Plane stopped
Auth query → ok
Pi builtins present
CommandCode present
```

### B2 — Auth query while Data Plane failed

Force a deterministic port conflict/start failure.

Auth query and Catalog query remain available.

### B3 — Login while stopped

Run CommandCode API-key login while Data Plane is stopped.

Verify:

- typed secret prompt occurs;
- credential persists;
- Auth query reports connected;
- Data Plane remains stopped until explicitly started.

### B4 — Stop → Login → Start

```text
start Backend
stop Data Plane
login Provider
start Data Plane
send request
request uses logged-in credential
```

No Backend restart.

### B5 — restart keeps Provider Runtime

Capture Provider Runtime/Models identity through a test seam and prove Data Plane stop/start creates new serving composition while the Provider Models identity remains the same.

## 23.3 Catalog tests

### C1 — catalog query while stopped

Catalog contains Provider/model facts with Data Plane stopped.

### C2 — login updates catalog availability

Successful login schedules refresh and eventually publishes a new catalog version/model availability.

### C3 — catalog failure does not erase auth

Credential remains connected when refresh fails.

### C4 — in-flight catalog snapshot

Login/recompose during an in-flight request affects only later requests.

## 23.4 Alias tests

### A1 — every Catalog model receives a default alias

Given an authoritative Catalog snapshot, the effective Alias registry contains exactly one alias per canonical model target and the untouched alias is exactly:

```text
providerId/modelId
```

The test generates expected aliases from Catalog facts; it does not maintain a separate expected alias table.

### A2 — slash-containing model IDs are preserved exactly

For:

```text
provider = commandcode-private
model = deepseek/deepseek-v4-flash
```

expect the default alias:

```text
commandcode-private/deepseek/deepseek-v4-flash
```

and prove resolution uses the explicit canonical target rather than parsing the alias string.

### A3 — custom alias replaces, not supplements, the default

```text
default: anthropic/claude-sonnet-4-6
set_for_model(..., alias = "sonnet")
```

results in one effective alias for the target:

```text
sonnet
```

The generated default is suppressed and no duplicate error is emitted.

### A4 — reset restores the generated default

After a custom override, `reset_for_model` removes only that target's user override and immediately restores `providerId/modelId`.

### A5 — Catalog changes generate defaults automatically

A newly appearing model receives a default alias after the Catalog snapshot swap without a file write.

A model removed from the active Catalog no longer contributes a generated default.

### A6 — custom collisions fail closed

A custom alias that collides with another target's effective default/custom alias is rejected and the previous effective registry remains active.

### A7 — client-visible model identity follows the effective alias

Prove `/v1/models`, Codex catalog generation, and alias-only request selection expose/use the generated default when untouched and the custom alias after override.

Canonical Provider/model target facts are not added as a separate user-facing selection contract.

## 23.5 Control Plane tests

### CP1 — source wire contract

All three source values round-trip; missing/unknown values fail closed.

### CP2 — Auth query exact Pi coverage

Control Plane Auth query's `pi_builtin` IDs equal the pinned `builtinProviders()` IDs.

### CP3 — no Data Plane lifecycle dependency

Stop/fail runtime commands do not make Auth/Catalog commands return `unavailable`.

## 23.6 Renderer tests

Using fake `LuckyTokenDesktopApi` only:

- renders Pi builtin and bundled Providers generically;
- groups connected/available;
- filters by search;
- renders auth actions solely from projected metadata;
- handles API-key prompt;
- handles OAuth URL/device-code/progress/cancel;
- distinguishes auth success from catalog refresh failure;
- re-queries catalog after catalog version changes;
- renders every known model with an already assigned effective alias;
- shows Add alias / Edit alias as a model-row action without exposing a target selector;
- sends target-scoped Alias mutations rather than rewriting the raw alias file;
- reset restores the generated `providerId/modelId` alias;
- contains no Provider-ID branching.

A static architecture/certification test should reject Provider ID special-casing in the generic Provider page if practical without becoming brittle.

## 23.7 Packaged Electron E2E

Fresh isolated user state:

```text
launch packaged Electron
open Providers
expect CommandCode Private
expect representative Pi builtins (and exact Backend Pi coverage through API assertion)
stop Data Plane
Providers remain visible
login deterministic test Provider / CommandCode interaction
credential status updates
expand a model row
expect generated providerId/modelId alias
add a custom alias through the model action
expect effective alias to change
start Data Plane
send deterministic real request using the custom alias
open Activity
successful request visible
```

The deterministic release path must not require an external account/network credential.

Online CommandCode/Anthropic/OpenAI verification remains a separate explicitly authorized test.

## 23.8 Release certification

Release Backend must prove:

- bundled CommandCode package resolves from installed `node_modules`;
- Provider Runtime registers it without config;
- Pi built-in Provider IDs are discoverable;
- Auth query works before Data Plane startup success;
- packaged Electron can render/authenticate through the same Control Plane contract;
- every shipped Catalog model receives a generated default alias without a curated alias table;
- packaged Electron can override one model alias and use it for a real deterministic request.

Failure blocks release.

---

# 24. Implementation phases

The work should be implemented as vertical tracer bullets, not as one large refactor.

## Phase 0 — red product certification

Add failing tests for:

- fresh CommandCode discovery;
- exact Pi built-in discovery;
- Auth/Catalog while Data Plane stopped/failed;
- stopped-Gateway login;
- Catalog-derived default aliases for every model;
- custom alias override/reset behavior.

Do not change UI first.

## Phase 1 — bundled Provider composition

Add `bundled.ts`, reserve bundled identity/specifier, load CommandCode automatically, and certify release dependency resolution.

At the end of this phase, a direct Provider Runtime/Models composition sees CommandCode without user config.

## Phase 2 — extract Provider Runtime

Move the one Pi Models creation, credential authority construction, models.json composition bookkeeping, bundled/external package loading, and source resolver into `src/providers/runtime.ts`.

Keep behavior identical where ownership is not changing.

## Phase 3 — lift Catalog and derive model aliases

Create/bind catalog controller before Data Plane startup and bind it to Provider Runtime's catalog handle.

Keep Alias Authority in Application and reuse the existing small initialization holder if needed to break the catalog/alias startup cycle.

Replace the static curated alias default table with Catalog-derived `providerId/modelId` defaults for every canonical model target. Add target-scoped set/reset Alias mutations and prove custom override/reset semantics before changing Renderer UI.

## Phase 4 — make Data Plane consume Provider Runtime facts

Replace Provider creation inside `createConfiguredLuckyTokenComposition()` with injected `Models` and minimal credential scrub capability.

Rename/refactor the remaining function to a Data Plane composition.

Prove restart reuse.

## Phase 5 — make Auth/Credential/Catalog always available

Wire Control Plane handlers directly to Backend-lifetime Provider Runtime/authorities.

Remove optional normal-state `authModels`/`credentialAuthority` slots and Data Plane-caused Auth unavailability.

## Phase 6 — correct Provider readiness summary

Derive coarse `ApplicationStatus.provider` from catalog model availability and update it on catalog snapshot publication.

Update Home/Connect tests to use the corrected meaning.

## Phase 7 — complete Providers product surface

Implement generic Provider source labels, grouping/search, connected/available state, login interaction, catalog convergence, actionable failures, model rows, and the Add/Edit alias action.

The normal UI never exposes Provider/model target mapping mechanics or raw Alias file editing.

No Provider-specific UI code.

## Phase 8 — real activation E2E and cleanup

Run packaged Electron activation flow with Data Plane stopped/restarted and a deterministic request.

Delete obsolete ownership paths and old CommandCode user-config behavior.

## Phase 9 — full quality gates

Run at minimum:

```text
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:distribution
npm run build
Desktop real-Electron lifecycle E2E
Provider activation product E2E
```

Then perform architecture/code review against this specification and the Electron Architecture Specification.

---

# 25. Acceptance criteria

This specification is complete only when every item below is true.

## Provider discovery

- [ ] Fresh Backend exposes every Provider from the pinned Pi `builtinProviders()` catalog.
- [ ] Fresh Backend exposes CommandCode Private without `providerPackages` configuration.
- [ ] Provider source is projected correctly and generically.
- [ ] User configuration cannot shadow bundled CommandCode identity.

## Provider lifecycle

- [ ] Provider Runtime is created once per Backend Application lifetime.
- [ ] Data Plane stop/start/restart does not recreate Provider Runtime.
- [ ] Auth query works when Data Plane is stopped.
- [ ] Auth query works when Data Plane is failed.
- [ ] Catalog query/refresh works when Data Plane is stopped.

## Authentication

- [ ] CommandCode API-key login runs through Pi `Models.login()`.
- [ ] Pi built-in OAuth/API-key login actions are projected from Pi metadata.
- [ ] Credentials persist in the one existing Pi-compatible store.
- [ ] Login while Data Plane is stopped succeeds.
- [ ] Starting Data Plane after login uses the newly stored credential without Backend restart.
- [ ] Credential secrets never enter status/catalog projections.

## Catalog/model state

- [ ] Successful login triggers Backend-owned catalog refresh.
- [ ] Connected credential state remains connected if model refresh fails.
- [ ] Model counts/availability update after catalog publication.
- [ ] In-flight requests retain captured model facts while later requests see refreshed facts.

## Alias/model identity

- [ ] Every model in the active Catalog has exactly one effective alias without user configuration.
- [ ] The generated default alias is exactly `providerId/modelId`, including models whose `modelId` itself contains `/`.
- [ ] Generated defaults are derived from Catalog facts and are not persisted.
- [ ] The static curated default alias table and redundant defaults generation counter are removed.
- [ ] A valid custom alias replaces the generated default for exactly one canonical model target; both are never simultaneously effective.
- [ ] Reset/delete of the custom override restores the generated default automatically.
- [ ] Custom alias collisions fail closed without replacing the previous effective registry.
- [ ] New Catalog models receive defaults automatically after publication.
- [ ] `/v1/models`, Codex catalog generation, and alias-only request selection use the effective alias.
- [ ] Canonical Provider/model target selection remains an internal implementation detail.

## Product UI

- [ ] Providers page never appears empty merely because the Data Plane is stopped/failed.
- [ ] Providers page shows Connected and Available groups plus search.
- [ ] Provider actions are driven only by projected Provider auth metadata.
- [ ] CommandCode Private is labeled as LuckyToken-bundled without UI special-casing its authentication flow.
- [ ] Pi built-ins use the same generic card/login components.
- [ ] Auth failure and Catalog failure are presented as distinct states.
- [ ] Provider model rows show the current effective alias and an Add/Edit alias icon/action.
- [ ] Add alias never asks the user to choose a Provider or model target; the row already determines the model.
- [ ] The normal product UI does not expose raw `model-aliases.json` structure.
- [ ] A custom alias can be reset to the default from the same model-scoped interaction.

## Release

- [ ] Shipped Backend contains/resolves the CommandCode Private package.
- [ ] Release certification proves fresh Provider discovery.
- [ ] Packaged Electron proves stopped-Gateway login and subsequent successful request.
- [ ] Provider activation E2E is a release blocker.

---

# 26. Rejected alternatives

## 26.1 Add CommandCode to first-run `providerPackages`

Rejected as the final design.

It would make a product-bundled Provider look user-installed and preserve the wrong configuration ownership.

## 26.2 Add a second Provider Registry service

Rejected.

Pi `Models.getProviders()` already owns the Provider collection. Duplicating Provider identity/name/auth metadata would create synchronization work and violate one-authority design.

Only bounded `providerId → source` metadata is added.

## 26.3 Keep Provider Runtime inside Data Plane and make UI auto-start Gateway

Rejected.

This hides the ownership error and makes Provider configuration depend on HTTP listener availability/port state.

## 26.4 Create separate Pi Models for management and serving

Rejected.

Login and request execution could diverge in credentials, catalog generation, package composition, or dynamic model refresh.

## 26.5 Move Alias into Provider Runtime

Rejected.

Alias is routing policy over Provider/model facts, not Provider identity/auth/catalog ownership.

## 26.6 Add Provider-specific renderer adapters

Rejected.

Pi Provider metadata and typed Auth interactions already define the generic behavior needed by the UI.

## 26.7 Rewrite Login or Provider Package contracts

Rejected.

The existing Pi `Models.login()` and LuckyToken Provider Package contract already provide the required semantics.

## 26.8 Keep the static curated alias default table

Rejected.

A selected-model table means newly available Pi/bundled/user models can exist without any usable alias and forces LuckyToken to maintain model identity data that the Catalog already owns.

Default aliases are instead a pure function of the authoritative canonical Catalog targets.

## 26.9 Allow both generated default and custom alias to remain effective

Rejected for V1.

LuckyToken's alias-only serving contract already has one-effective-alias-per-target semantics. Keeping multiple aliases per target adds collision, discovery, client-catalog, and edit/delete semantics that are not required by the product request.

A user custom alias is an override/rename of the already assigned default alias.

## 26.10 Expose a Provider/model target picker when adding an alias

Rejected.

The user starts the action from a concrete model row, so the canonical target is already known. Exposing target selection leaks internal routing representation and creates opportunities to map the wrong model.

The product action accepts only the new alias (or reset); Alias Authority owns the mapping mutation.

---

# 27. Final architecture invariant

After implementation, this must be true:

```text
Backend Application lifetime
│
├── Provider Runtime ───────────────────────────────┐
│    one Pi Models                                 │
│    Pi builtins                                   │
│    CommandCode bundled                           │
│    user Providers                                │
│    one Credential Authority                      │
│    one catalog runtime handle                    │
│                                                  │
├── Catalog Controller ←───────────────────────────┘
│    Backend lifetime
│
├── Alias Authority
│    Catalog-derived default for every model: providerId/modelId
│    optional one user override per canonical target
│
├── Settings / Ledger / Diagnostics / Control Plane
│
└── Data Plane Supervisor
      ├── serving instance 1
      ├── stopped
      ├── serving instance 2
      └── ...

All serving instances consume the same Backend-lifetime Provider Models.
```

The product invariant is equally simple:

> **A user can always discover and authenticate Providers while LuckyToken Backend is healthy, regardless of whether the model HTTP Gateway is running. Every Catalog model is immediately usable through a generated `providerId/modelId` alias, and the user may replace that alias from the model row without understanding internal Provider/model routing.**

That invariant is the release-level definition of Provider activation for LuckyToken V1.
