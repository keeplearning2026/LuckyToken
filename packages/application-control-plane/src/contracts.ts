import type {
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticsQueryResult,
} from "./diagnostics-contract.js";
import type {
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerQueryResult,
} from "./ledger-contract.js";
import type {
  CaptureEvent,
  CaptureQuery,
  CaptureQueryResult,
} from "./capture-contract.js";
import type {
  AnalyticsOptionsResult,
  AnalyticsQuery,
  AnalyticsResult,
} from "./analytics-contract.js";
import type { RecoveryProjection } from "./backup-contract.js";
import type { BackupCreateCommand, BackupResult } from "./backup-contract.js";
import type { AttentionProjection } from "./attention-contract.js";

export const controlPlaneVersion = 1 as const;

export interface ApplicationIdentity {
  readonly id: "luckytoken";
  readonly version: string;
}

/** Owner identity of the one active LuckyToken application instance (Ticket
 *  05). The Control Plane host runs inside the owner process; every client
 *  connection is therefore an attached non-owner viewer. */
export interface ApplicationOwnership {
  readonly owner: {
    readonly kind: "cli" | "desktop";
    readonly pid: number;
    readonly startedAt: string;
  };
}

export interface ApplicationStatus {
  readonly modelDataPlane:
    "stopped" | "starting" | "running" | "stopping" | "failed";
  readonly provider: "configured" | "unconfigured";
  readonly dataPlane?: DataPlaneStatus;
}

export type DataPlaneFailureCode =
  "port_in_use" | "start_failed" | "stop_failed";

export interface DataPlaneFailure {
  readonly code: DataPlaneFailureCode;
  readonly message: string;
}

export interface DataPlaneStatus {
  readonly configuredOrigin: string;
  readonly configuredPort: number;
  readonly failure?: DataPlaneFailure;
}

export interface StatusSnapshot extends ApplicationStatus {
  readonly sequence: number;
  /** Optional registered settings catalog projection (Ticket 06). */
  readonly settings?: Readonly<Record<string, RegisteredSetting>>;
  /** Present only while a non-loopback bind action waits for confirmation. */
  readonly confirmation?: LanConfirmation;
  /** Present while at least one history persistence authority is unavailable
   *  (Ticket 23): the audit-unavailable state, visible in every snapshot
   *  until acknowledged or demonstrated recovery. Acknowledgment never
   *  claims storage recovered. */
  readonly persistence?: PersistenceProjection;
  /** Ticket 24: present when one or more LuckyToken-owned files cannot be
   * safely interpreted. The local Control Plane remains usable while the
   * unsafe Data Plane stays stopped. */
  readonly recovery?: RecoveryProjection;
  /** Ticket 25: value-free actionable conditions plus a recent request
   * failure count. Ordinary request failures never become conditions. */
  readonly attention?: AttentionProjection;
  /** Owner identity of the one active instance (Ticket 05). */
  readonly ownership?: ApplicationOwnership;
  /** Optional sanitized models.json projection (Ticket 08). */
  readonly models?: ModelsProjection;
  /** Optional sanitized auth.json credential projection (Ticket 12). */
  readonly credentials?: CredentialProjection;
  /** Optional sanitized catalog lifecycle projection (Ticket 11). */
  readonly catalog?: CatalogStatusProjection;
  /** Optional sanitized model-aliases.json projection (Ticket 14). */
  readonly aliases?: AliasStatusProjection;
}

/** Registered setting: type, default, validation, sensitivity, and apply mode
 *  are declared by the backend's authoritative catalog; values are typed and
 *  validated. Restart-required settings also report the effective value. */
export interface RegisteredSetting {
  readonly key: string;
  readonly type: "boolean" | "number" | "string";
  readonly default: boolean | number | string;
  readonly validation: unknown;
  readonly sensitivity: "public" | "secret";
  readonly applyMode: "hot-apply" | "restart-required";
  readonly value: boolean | number | string;
  readonly effective?: boolean | number | string;
}

export interface LanConfirmation {
  readonly actionId: string;
  readonly settingKey: "server.bindHost";
  readonly value: string;
  readonly message: string;
}

/**
 * Sanitized models.json file projection (Ticket 08). Merged into published
 * status snapshots: only the revision, file location, presence, validity and
 * a value-free error are visible; raw content and provider data never reach
 * the status stream.
 */
export interface ModelsProjection {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly error?: ModelsFileError;
}

export type ModelsFileErrorKind = "parse" | "schema" | "load" | "storage";

/** Exact source location for syntax errors: 1-based line/column plus the
 *  character position within the parsed (comment-stripped) text. */
export interface ModelsFileErrorLocation {
  readonly line: number;
  readonly column: number;
  readonly position?: number;
}

export interface ModelsFileError {
  readonly kind: ModelsFileErrorKind;
  readonly message: string;
  readonly location?: ModelsFileErrorLocation;
}

/** Full authoritative models.json state returned by the models commands.
 *  `raw` is the exact current file content (or "" when the file is absent)
 *  so the raw editor can round-trip bytes; `providers` is the parsed record
 *  for the structured editor and carries provider/model extension fields.
 *  `catalog` (Ticket 09) is the effective built-in + user catalog projection
 *  and is present exactly when `valid` is true; it never carries credentials
 *  or request auth state. */
export interface ModelsFileState {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly raw: string;
  readonly providers?: Readonly<Record<string, unknown>>;
  /** Effective Provider/model catalog (Ticket 09). */
  readonly catalog?: EffectiveCatalogProjection;
  readonly error?: ModelsFileError;
}

/**
 * The repository-pinned Pi implementation that the effective catalog
 * composition is compatible with. Every effective catalog projection
 * identifies its baseline so consumers can tell which schema/semantics
 * produced the result.
 */
export interface EffectiveCatalogBaseline {
  readonly package: "@earendil-works/pi-coding-agent";
  readonly version: "0.84.1";
  readonly schema: "pi-coding-agent-0.84.1-models-json-schema";
}

/** Source layer of an effective Provider entry. */
export type EffectiveProviderLayer = "builtin" | "user" | "overlaid";

/** Source layer of an effective model entry. `overridden` is the topmost
 *  layer: a model that is also overridden is labeled `overridden` and its
 *  `overriddenFields` names the fields the modelOverrides contributed. */
export type EffectiveModelLayer =
  "builtin" | "user" | "upserted" | "overridden";

/** Public cost facts of an effective model (pinned shape). */
export interface EffectiveModelCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly tiers?: readonly unknown[];
}

/**
 * One effective model: the exact facts Pi would construct from the same
 * valid input. Credential and request-state fields (apiKey, headers, auth)
 * never appear here — Ticket 10 owns header/auth compatibility.
 */
export interface EffectiveModelProjection {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly cost: EffectiveModelCost;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly layer: EffectiveModelLayer;
  /** Fields the provider `modelOverrides` contributed to this model. */
  readonly overriddenFields?: readonly string[];
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly compat?: Readonly<Record<string, unknown>>;
}

/** One effective Provider: built-in base facts overlaid by user config. */
export interface EffectiveProviderProjection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly layer: EffectiveProviderLayer;
  readonly models: readonly EffectiveModelProjection[];
}

/** Value-free per-Provider composition failure (pinned Pi wording). */
export interface EffectiveCatalogCompositionError {
  readonly providerId: string;
  readonly message: string;
}

/**
 * The authoritative effective Provider/model catalog (Ticket 09): Pi
 * built-ins as the lower layer with valid models.json configuration applied
 * above them with pinned Pi semantics. One projection, no credentials.
 */
export interface EffectiveCatalogProjection {
  readonly schemaVersion: "luckytoken-effective-catalog-v1";
  readonly baseline: EffectiveCatalogBaseline;
  readonly providers: readonly EffectiveProviderProjection[];
  readonly compositionErrors: readonly EffectiveCatalogCompositionError[];
}

/**
 * Catalog refresh lifecycle (Ticket 11): the refresh state of one Provider
 * in the authoritative active catalog snapshot. `known` is a static
 * Provider (no dynamic refresh); `cached` means dynamic facts were restored
 * from the validated LuckyToken-owned cache before any network refresh;
 * `refreshing` is an in-flight refresh; `succeeded`/`failed` are the last
 * network refresh outcome (a failed Provider keeps its cached/built-in
 * facts and carries a value-safe error).
 */
export type CatalogProviderState =
  "known" | "cached" | "refreshing" | "succeeded" | "failed";

/** Auth-based model usability in the active catalog snapshot. */
export type CatalogModelAvailability = "available" | "unavailable" | "unknown";

/** What started a refresh run. */
export type CatalogRefreshTrigger =
  "startup" | "login" | "page_open" | "manual";

/** One model in the active catalog snapshot. `dynamic` marks facts that
 *  came from the Provider's dynamic catalog overlay (cache or network). */
export interface CatalogModelProjection {
  readonly id: string;
  readonly dynamic: boolean;
  readonly availability: CatalogModelAvailability;
}

/** One Provider in the active catalog snapshot. */
export interface CatalogProviderProjection {
  readonly providerId: string;
  readonly name: string;
  /** Provider has a dynamic refresh implementation. */
  readonly dynamic: boolean;
  readonly state: CatalogProviderState;
  /** Value-safe failure summary; present only when state is "failed". */
  readonly error?: string;
  /** Value-safe failure category; present only when state is "failed". */
  readonly errorCode?: string;
  readonly refreshedAt?: number;
  readonly cachedAt?: number;
  readonly models: readonly CatalogModelProjection[];
}

/** One value-safe Provider refresh failure (fixed template, safe category). */
export interface CatalogRefreshErrorProjection {
  readonly providerId: string;
  readonly code: string;
  readonly message: string;
}

/**
 * One authoritative active catalog snapshot (Ticket 11): versioned and
 * atomically swapped after each refresh cycle. New requests resolve the
 * served catalog from the swapped snapshot; in-flight invocations keep the
 * Model objects they already captured. Never carries credentials, headers,
 * environment values or raw Provider errors.
 */
export interface CatalogSnapshotProjection {
  readonly version: number;
  readonly modelsJsonValid: boolean;
  /** Value-free models.json file error when the file is not loadable. */
  readonly modelsJsonError?: ModelsFileError;
  readonly refreshedAt?: number;
  readonly providers: readonly CatalogProviderProjection[];
  /** The last refresh run's Provider failures, aggregated. */
  readonly refreshErrors: readonly CatalogRefreshErrorProjection[];
}

/** Bounded per-Provider results of a completed manual refresh. */
export interface CatalogRefreshReportProjection {
  readonly trigger: "manual";
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly providers: readonly {
    readonly providerId: string;
    readonly outcome: "succeeded" | "failed" | "skipped";
    readonly error?: string;
    readonly errorCode?: string;
  }[];
}

/**
 * Sanitized catalog lifecycle projection merged into status snapshots:
 * version, in-flight refresh flag and the failed Provider ids (for precise
 * badges). Bounded; the full per-Provider/model facts ride only on catalog
 * query/refresh command results.
 */
export interface CatalogStatusProjection {
  readonly version: number;
  readonly refreshing: boolean;
  readonly refreshedAt?: number;
  readonly failedProviderIds: readonly string[];
}

/**
 * Versioned catalog commands (Ticket 11): query the one authoritative
 * active catalog snapshot, schedule a non-blocking background refresh, or
 * run a forced manual refresh that resolves with bounded per-Provider
 * results. `page_open` (background) is how the Models & Aliases page
 * triggers its refresh; `manual` is the explicit Refresh action.
 */
export type CatalogCommand =
  | { readonly command: "query" }
  | {
      readonly command: "refresh";
      readonly mode: "background" | "manual";
    };

export type CatalogCommandOutcome = "ok" | "scheduled" | "unavailable";

export interface CatalogCommandResult {
  readonly outcome: CatalogCommandOutcome;
  readonly snapshot: CatalogSnapshotProjection;
  /** Present only for a completed manual refresh. */
  readonly refresh?: CatalogRefreshReportProjection;
}

/** Handles versioned catalog commands against the refresh controller. */
export type CatalogCommandHandler = (
  command: CatalogCommand,
) => Promise<CatalogCommandResult>;

/**
 * Source layer of an effective alias: `default` is a curated built-in
 * mapping (the lower layer), `user` is an explicit mapping from the
 * manually editable LuckyToken-owned model-aliases.json (the authority
 * layer, always winning).
 */
export type AliasLayer = "default" | "user";

/** Distinguished alias validation failure category (Ticket 14):
 *  `invalid` is a malformed alias/target, `ambiguous` is a target that
 *  cannot name one canonical model, `unknown` is a well-formed target absent
 *  from the authoritative catalog snapshot, and `duplicate` is a canonical
 *  target that already has an effective alias. Alias text is opaque and may
 *  contain `/`; it is never interpreted as canonical identity. */
export type AliasValidationCode =
  | "invalid"
  | "ambiguous"
  | "unknown"
  | "duplicate";

/** Canonical Provider/model target of one alias. */
export interface AliasCanonicalTarget {
  readonly provider: string;
  readonly model: string;
}

/** One effective alias in the authoritative registry. */
export interface EffectiveAliasProjection {
  readonly alias: string;
  readonly target: AliasCanonicalTarget;
  readonly layer: AliasLayer;
}

/** One rejected alias entry with a fixed value-safe message. */
export interface AliasValidationErrorProjection {
  readonly alias: string;
  readonly code: AliasValidationCode;
  readonly message: string;
}

/**
 * The authoritative effective alias registry (Ticket 14): curated defaults
 * as the lower layer, explicit user mappings as the authority layer, and
 * every rejected entry distinguished by failure category. Never carries
 * credentials or file content.
 */
export interface EffectiveAliasRegistryProjection {
  readonly defaultsVersion: number;
  readonly aliases: readonly EffectiveAliasProjection[];
  readonly errors: readonly AliasValidationErrorProjection[];
}

/** Value-free failure kinds of the model-aliases.json authority. */
export type AliasFileErrorKind =
  | "parse"
  | "schema"
  | "validation"
  | "load"
  | "storage";

/** Value-free failure of the model-aliases.json authority; `entries` is
 *  present exactly for kind `validation` and carries the per-alias failure
 *  categories (never raw content or guessed repairs). */
export interface AliasFileError {
  readonly kind: AliasFileErrorKind;
  readonly message: string;
  readonly entries?: readonly AliasValidationErrorProjection[];
}

/**
 * Full authoritative model-aliases.json state returned by the alias
 * commands. `raw` is the exact current file content (or "" when the file
 * is absent) so manual round-trips stay byte-exact; `aliases` is the
 * parsed user mapping record (valid files only); `effective` is the
 * authoritative merged registry (defaults + user mappings) and is present
 * whenever the file is absent or valid — a broken file contributes no
 * user mappings, never a guessed repair. `catalogVersion` is the Ticket 11
 * catalog snapshot the effective registry was validated against.
 */
export interface AliasFileState {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly raw: string;
  readonly defaultsVersion: number;
  readonly catalogVersion: number;
  readonly aliases?: Readonly<Record<string, unknown>>;
  readonly effective?: EffectiveAliasRegistryProjection;
  readonly error?: AliasFileError;
}

/** Sanitized model-aliases.json projection merged into status snapshots:
 *  revision, location, presence, validity and value-free error only — never
 *  content. */
export interface AliasStatusProjection {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly defaultsVersion: number;
  readonly error?: AliasFileError;
}

/**
 * Versioned alias registry commands (Ticket 14): query the one
 * authoritative model-aliases.json state and the merged effective registry,
 * or replace the user mapping record with compare-and-swap on the revision
 * the client was served. A rejected proposal (invalid, ambiguous, unknown
 * or duplicate target) never replaces the active registry.
 */
export type AliasCommand =
  | { readonly command: "query" }
  | {
      readonly command: "write";
      readonly revision: number;
      readonly aliases: Readonly<Record<string, unknown>>;
    };

export type AliasCommandOutcome =
  | "ok"
  | "conflict"
  | "invalid"
  | "storage_failure";

export interface AliasCommandResult {
  readonly outcome: AliasCommandOutcome;
  /** The authoritative state after the attempt (current revision). */
  readonly state: AliasFileState;
  /** Value-free failure detail: the rejected proposal's validation errors
   *  (`invalid`) or the sanitized storage fault (`storage_failure`). */
  readonly error?: AliasFileError;
}

/** Handles versioned alias registry commands against the live authority. */
export type AliasCommandHandler = (
  command: AliasCommand,
) => Promise<AliasCommandResult>;

/** Optional local Codex configuration integration. Native Codex request
 * support is a Data Plane capability and is deliberately not controlled by
 * this desired-state switch. */
export type CodexIntegrationObservedState =
  | "native"
  | "managed"
  | "drifted"
  | "conflict"
  | "unavailable";

export interface CodexIntegrationProjection {
  readonly desiredEnabled: boolean;
  readonly observedState: CodexIntegrationObservedState;
  readonly codexHome: string;
  readonly configPath: string;
  readonly catalogPath: string;
  readonly endpoint?: string;
  readonly modelCount?: number;
  readonly warnings: readonly string[];
  readonly restartRequired: boolean;
  readonly message?: string;
}

export type CodexIntegrationCommand =
  | { readonly command: "query" }
  | { readonly command: "set_enabled"; readonly enabled: boolean }
  | { readonly command: "sync_catalog" };

export interface CodexIntegrationCommandResult {
  readonly state: CodexIntegrationProjection;
}

export type CodexIntegrationCommandHandler = (
  command: CodexIntegrationCommand,
) => Promise<CodexIntegrationCommandResult>;

export type ModelsCommand =
  | { readonly command: "query" }
  | {
      readonly command: "write_raw";
      readonly revision: number;
      readonly content: string;
    }
  | {
      readonly command: "write_structured";
      readonly revision: number;
      readonly providers: Readonly<Record<string, unknown>>;
    };

export type ModelsCommandOutcome =
  "ok" | "conflict" | "invalid" | "storage_failure";

export interface ModelsCommandResult {
  readonly outcome: ModelsCommandOutcome;
  /** The authoritative state after the attempt (current revision). */
  readonly state: ModelsFileState;
  /** Value-free failure detail: the rejected proposal's validation error
   *  (`invalid`) or the sanitized storage fault (`storage_failure`). */
  readonly error?: ModelsFileError;
}

/**
 * Ticket 12 — API-key credential management and effective authentication
 * status. One Provider has one stored auth.json slot; every mutation runs
 * through the single serialized Credential Authority with a revision
 * compare-and-swap, so UI and CLI can never lose a concurrent update.
 */

/** Effective auth source precedence (pinned Pi): stored credential, then
 *  models.json configured key (literal/`$ENV`/`!command`), then ambient
 *  environment. `none` means nothing resolves. */
export type CredentialEffectiveSource =
  "stored" | "environment" | "models.json" | "command" | "none";

/**
 * Bounded structural authentication facts for one Provider. Credential
 * values, environment variable names, command text, headers and raw
 * credential objects never appear in this projection.
 */
export interface ProviderAuthStatus {
  readonly providerId: string;
  /** The Provider's one stored auth.json slot is occupied. */
  readonly stored: boolean;
  readonly storedType?: "api_key" | "oauth";
  /** An ambient (builtin) source resolves for this Provider. */
  readonly environment: boolean;
  /** models.json declares an apiKey for this Provider. */
  readonly modelsJson: boolean;
  /** The models.json apiKey is a `!command` source. */
  readonly commandDerived: boolean;
  /** A stored OAuth credential has expired. */
  readonly expired: boolean;
  /** No effective auth resolves for this Provider. */
  readonly unavailable: boolean;
  readonly effectiveSource: CredentialEffectiveSource;
}

export type CredentialFileErrorKind = "parse" | "invalid" | "load";

/** Value-free auth.json file error (Ticket 12): syntax/shape locations and
 *  structural descriptions only, never file content or credential values. */
export interface CredentialFileError {
  readonly kind: CredentialFileErrorKind;
  readonly message: string;
}

/**
 * Sanitized auth.json projection merged into status snapshots: file facts
 * plus bounded per-Provider authentication status. No secret values.
 */
export interface CredentialProjection {
  readonly revision: number;
  readonly path: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly error?: CredentialFileError;
  readonly providers: readonly ProviderAuthStatus[];
}

/** One importable auth.json entry in a preview result (metadata only). */
export interface CredentialImportEntryPreview {
  readonly providerId: string;
  readonly type: "api_key" | "oauth";
  readonly wouldOverwrite: boolean;
}

/** One Provider selection of an import apply. */
export interface CredentialImportSelection {
  readonly providerId: string;
  readonly overwrite: boolean;
}

/** Per-Provider outcome of an import apply. */
export interface CredentialImportApplyEntryResult {
  readonly providerId: string;
  readonly outcome:
    "applied" | "unchanged" | "skipped" | "conflict" | "overwrite_required";
}

/**
 * Versioned Credential commands (Ticket 12): UI and CLI manage the
 * Pi-compatible auth.json through these commands. Every mutation carries
 * the expected revision from a prior query/preview so a stale UI/CLI can
 * never overwrite a newer credential. `login` stores the value verbatim
 * (literal secret, `$ENV` reference or `!command` source; resolution is the
 * pinned Ticket 10 request-path behavior). `import_preview` validates a
 * Pi-compatible auth.json payload and returns the Provider-by-Provider
 * plan; `import_apply` writes only the selected Providers with the
 * previewed overwrite confirmations.
 */
export type CredentialCommand =
  | { readonly command: "query" }
  | {
      readonly command: "login";
      readonly providerId: string;
      readonly expectedRevision: number;
      readonly value: string;
      /** Explicit confirmation that an occupied slot may be replaced. */
      readonly overwrite: boolean;
    }
  | {
      readonly command: "logout";
      readonly providerId: string;
      readonly expectedRevision: number;
    }
  | {
      readonly command: "import_preview";
      readonly expectedRevision: number;
      readonly content: string;
    }
  | {
      readonly command: "import_apply";
      readonly expectedRevision: number;
      readonly importId: string;
      readonly selections: readonly CredentialImportSelection[];
    };

export type CredentialCommandOutcome =
  | "ok"
  | "conflict"
  | "invalid"
  | "unknown_provider"
  | "overwrite_required"
  | "storage_failure"
  | "unavailable";

export interface CredentialCommandResult {
  readonly outcome: CredentialCommandOutcome;
  /** The authoritative auth.json revision after the attempt. */
  readonly revision: number;
  /** Authoritative sanitized auth.json projection after the attempt. */
  readonly state: CredentialProjection;
  /** Value-free failure detail (`conflict`, `invalid`, `storage_failure`). */
  readonly error?: string;
  /** Present on successful login/logout: whether the file changed. */
  readonly changed?: boolean;
  /** Present on a successful import_preview: the apply session id. */
  readonly importId?: string;
  readonly previewEntries?: readonly CredentialImportEntryPreview[];
  /** Present on import_apply: per-selection results. */
  readonly entries?: readonly CredentialImportApplyEntryResult[];
}

/**
 * Ticket 13 — Provider-owned account/subscription authentication projection.
 *
 * The top-level UI choices are exactly "Use an account or subscription" and
 * "Use an API key". Only Provider metadata may mark a flow as a true
 * subscription: `subscription` below is `provider.auth.oauth.isSubscription`
 * and nothing else may label a flow. The Provider owns every authentication
 * step; the renderer projects typed interaction events and never branches on
 * Provider ids or implements Provider-specific OAuth/API-key protocols.
 */

/** One Provider's interactive login options, projected from Provider
 *  metadata only (never renderer labels). */
export interface AuthProviderOption {
  readonly providerId: string;
  readonly name: string;
  /** The Provider declares an account/OAuth login. */
  readonly account: boolean;
  /** True only when Provider metadata (`oauth.isSubscription`) marks the
   *  account flow as a real subscription; OAuth/account alone is never
   *  mislabeled as a subscription. */
  readonly subscription: boolean;
  /** Provider-declared label for the account login option. */
  readonly accountLabel?: string;
  /** The Provider declares API-key auth (the Ticket 12 stored-value path). */
  readonly apiKey: boolean;
  /** Provider-declared label for the API-key login option. */
  readonly apiKeyLabel?: string;
  /** Bounded effective authentication status facts (Ticket 12 shape). */
  readonly status: ProviderAuthStatus;
}

/** The authoritative per-Provider login options for one auth query. */
export interface AuthOptionsProjection {
  readonly providers: readonly AuthProviderOption[];
}

export interface AuthInfoLink {
  readonly url: string;
  readonly label?: string;
}

/** One option of a Provider-owned select prompt. */
export interface AuthPromptOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * Typed interaction events projected from the Provider-owned
 * AuthInteraction. Browser/device URLs are always visible and copyable
 * (opening is an OS capability of the thin desktop shell, with a manual
 * fallback); prompts carry a correlation id so responses never cross
 * flows. No credential or code value ever leaves the flow. Cancellation,
 * success and failure are terminal outcomes of the login command result.
 */
export type AuthInteractionEvent =
  | {
      readonly type: "info";
      readonly message: string;
      readonly links?: readonly AuthInfoLink[];
    }
  | {
      readonly type: "auth_url";
      readonly url: string;
      readonly instructions?: string;
    }
  | {
      readonly type: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "progress"; readonly message: string }
  | {
      readonly type: "prompt";
      readonly promptId: string;
      readonly kind: "text" | "secret" | "manual_code" | "select";
      readonly message: string;
      readonly placeholder?: string;
      readonly options?: readonly AuthPromptOption[];
    };

/** A client response inside one in-flight Provider-owned login flow. */
export type AuthInteractionResponse =
  | {
      readonly type: "prompt_response";
      readonly promptId: string;
      readonly value: string;
    }
  | { readonly type: "cancel" };

/**
 * The interaction channel the Control Plane host provides to the auth
 * command handler for one in-flight login: `notify` projects typed events
 * to the client, `prompt` waits for the client's response to a typed
 * prompt, and `signal` aborts the whole flow (connection lost, cancel).
 */
export interface AuthInteractionChannel {
  readonly signal: AbortSignal;
  notify(event: AuthInteractionEvent): Promise<void>;
  prompt(input: {
    readonly kind: "text" | "secret" | "manual_code" | "select";
    readonly message: string;
    readonly placeholder?: string;
    readonly options?: readonly AuthPromptOption[];
  }): Promise<string>;
}

/**
 * Versioned Provider-auth commands (Ticket 13): `query` returns the
 * per-Provider login options plus the refreshed effective authentication
 * status; `login` runs a Provider-owned login flow through the typed
 * interaction channel and atomically persists the returned credential
 * through the Ticket 12 Credential Authority's serialization seam (the
 * same store and revision machinery — no second credential authority). UI
 * and CLI use this same contract. Logout stays on the Ticket 12
 * credential channel: it is the same backend contract surface.
 */
export type AuthCommand =
  | { readonly command: "query" }
  | {
      readonly command: "login";
      readonly providerId: string;
      readonly authType: "oauth" | "api_key";
    };

export type AuthCommandOutcome =
  | "ok"
  | "cancelled"
  | "failed"
  | "conflict"
  | "unknown_provider"
  | "unsupported"
  | "storage_failure"
  | "unavailable";

export interface AuthCommandResult {
  readonly outcome: AuthCommandOutcome;
  /** Authoritative sanitized auth.json projection after the attempt. */
  readonly state: CredentialProjection;
  /** Present on query: the per-Provider login options. */
  readonly options?: AuthOptionsProjection;
  /** Value-free failure detail (fixed templates; never raw errors). */
  readonly error?: string;
}

/**
 * Handles versioned Provider-auth commands. The interaction channel is
 * live only for a `login` command; `query` never uses it. Implementations
 * must keep failure messages value-free and must never delete an
 * unrelated Provider's credential.
 */
export type AuthCommandHandler = (
  command: AuthCommand,
  interaction: AuthInteractionChannel,
) => Promise<AuthCommandResult>;

export type SettingsCommand =
  | {
      readonly command: "query";
      readonly keys?: readonly string[];
    }
  | {
      readonly command: "set";
      readonly key: string;
      readonly value: unknown;
    }
  | {
      readonly command: "confirm";
      readonly actionId: string;
    };

export type SettingsCommandOutcome =
  | "ok"
  | "applied"
  | "pending"
  | "confirmation_required"
  | "unknown_key"
  | "invalid_value";

export interface SettingsCommandResult {
  readonly outcome: SettingsCommandOutcome;
  readonly error?: string;
  readonly confirmation?: LanConfirmation;
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}

export interface StatusEvent {
  readonly type: "status_changed";
  readonly sequence: number;
  readonly snapshot: StatusSnapshot;
}

/**
 * Versioned Client Token commands (Ticket 16 + Ticket 17 directory scopes):
 * UI and CLI manage the one active protocol-global token and canonical
 * directory-scoped tokens through these commands. List results are masked
 * metadata; Reveal is the only command that returns the active secret, and
 * only for the requested scope. Mutations carry the expected revision from
 * a prior list so a stale UI/CLI can never overwrite a newer token.
 *
 * Project scope inputs are raw picker/CLI directory paths; the backend
 * resolves them to the canonical real filesystem identity at the authority
 * boundary before any persistence or comparison.
 */
export type ClientTokenScopeRef =
  | { readonly type: "global" }
  | { readonly type: "project"; readonly projectDir: string };

export type ClientTokenCommand =
  | { readonly command: "list"; readonly protocolId: string }
  | {
      readonly command: "create";
      readonly protocolId: string;
      readonly scope: ClientTokenScopeRef;
      readonly token?: string;
    }
  | {
      readonly command: "reveal";
      readonly protocolId: string;
      readonly scope?: ClientTokenScopeRef;
    }
  | {
      readonly command: "rotate";
      readonly protocolId: string;
      readonly expectedRevision: number;
      readonly scope?: ClientTokenScopeRef;
      readonly token?: string;
    }
  | {
      readonly command: "remove";
      readonly protocolId: string;
      readonly expectedRevision: number;
      readonly scope?: ClientTokenScopeRef;
    };

export type ClientTokenCommandOutcome =
  | "ok"
  | "conflict"
  | "not_found"
  | "invalid_value"
  | "already_exists"
  | "invalid_directory"
  | "unknown_protocol"
  | "unavailable";

/** Value-free backend canonicalization failure taxonomy (never a raw
 *  input path). */
export type ClientTokenDirectoryRejection =
  "not_found" | "not_a_directory" | "inaccessible" | "race" | "invalid";

/** Masked scope metadata; the mask marker guarantees the wire never carries
 *  a raw token in list/mutation results. */
export interface MaskedClientTokenScope {
  readonly type: "global" | "project";
  /** Canonical real filesystem identity, backend-verified. */
  readonly projectDir?: string;
  readonly maskedToken: string;
}

export interface ClientTokenCommandResult {
  readonly outcome: ClientTokenCommandOutcome;
  readonly revision: number;
  readonly scopes?: readonly MaskedClientTokenScope[];
  /** Present only for an explicit Reveal of the requested active token. */
  readonly token?: string;
  /** Present only with outcome "invalid_directory". */
  readonly reason?: ClientTokenDirectoryRejection;
  readonly error?: string;
}

/** Handles versioned Client Token commands against the live authority. */
export type ClientTokenCommandHandler = (
  command: ClientTokenCommand,
) => Promise<ClientTokenCommandResult>;

/**
 * Request identity ledger seam (Ticket 17, Ticket 18 handoff): the public
 * projection carries only the optional client-provided session identity and
 * the canonical project context. The internal effective session identity is
 * not a field of this contract, so no ledger, wire decoder, or renderer can
 * substitute it for the client's id.
 */
export interface RequestIdentityRecord {
  readonly id: number;
  readonly time: number;
  readonly protocolId: string;
  readonly clientSessionId?: string;
  readonly projectDir?: string;
}

/** Observation input (Ticket 17 identity seam): carries only the optional
 *  client-provided session identity and canonical project context; the
 *  internal effective session identity is not a field of this contract. */
export interface RequestIdentityFact {
  readonly clientSessionId?: string;
  readonly projectDir?: string;
}

export interface RequestIdentitiesQueryResult {
  readonly records: readonly RequestIdentityRecord[];
}

export type RequestIdentitiesQueryHandler =
  () => Promise<RequestIdentitiesQueryResult>;

/** Public renderer projection: the client identity is always a displayable
 *  string and a missing one renders as `-`. The effective session identity
 *  has no field here, so it can never be projected as the client's id. */
export interface RequestIdentityProjection {
  readonly id: number;
  readonly time: number;
  readonly protocolId: string;
  readonly clientSessionId: string;
  readonly projectDir?: string;
}

export function projectRequestIdentity(
  record: RequestIdentityRecord,
): RequestIdentityProjection {
  return Object.freeze({
    id: record.id,
    time: record.time,
    protocolId: record.protocolId,
    clientSessionId: record.clientSessionId ?? "-",
    ...(record.projectDir === undefined
      ? {}
      : { projectDir: record.projectDir }),
  });
}

export interface ControlPlaneEndpoint {
  readonly pipeName: string;
  readonly capability: string;
}

export type {
  ControlPlaneDiagnostics,
  RuntimeDiagnosticDraft,
  RuntimeDiagnosticEvent,
  RuntimeDiagnosticLevel,
  RuntimeDiagnosticMessage,
  RuntimeDiagnosticQuery,
  RuntimeDiagnosticRecord,
  RuntimeDiagnosticsQueryResult,
  RuntimeDiagnosticsStore,
  RuntimeDiagnosticsStoreFactory,
} from "./diagnostics-contract.js";

export type {
  ControlPlaneRequestLedger,
  LedgerAliasFact,
  LedgerAttempt,
  LedgerAuthFacts,
  LedgerFailureInput,
  LedgerFailureSummary,
  LedgerFacts,
  LedgerModelSnapshot,
  LedgerNotice,
  LedgerOutcome,
  LedgerPersistenceFailure,
  LedgerPhase,
  LedgerTerminalFacts,
  LedgerTerminalOutcome,
  RequestLedger,
  RequestLedgerEntry,
  RequestLedgerEvent,
  RequestLedgerQuery,
  RequestLedgerQueryResult,
  RequestLedgerRecord,
  RequestLedgerStore,
  RequestLedgerStoreFactory,
} from "./ledger-contract.js";
export type { NormalizedTerminalUsage } from "@luckytoken/provider-contract/usage";
export {
  LEDGER_OUTCOMES,
  LEDGER_PHASES,
  assertLedgerOutcome,
  assertLedgerPhase,
} from "./ledger-contract.js";
export {
  averageOutputSpeedUnavailableReason,
  deriveRequestStatus,
  formatDuration,
  formatTimestamp,
  formatTokensPerSecond,
  formatCacheHitRate,
  ledgerPhaseLabel,
  projectAverageOutputTokensPerSecond,
  projectRequestLedger,
  projectRequestLedgerDetail,
  projectRequestUsage,
  protocolDisplayName,
  type PrimaryStatus,
  type RequestLedgerDetailProjection,
  type RequestLedgerListProjection,
  type RequestUsageProjection,
} from "./ledger-projection.js";

import type {
  HistoryAcknowledgeResult,
  HistoryCommand,
  HistoryCommandHandler,
  HistoryCommandResult,
  HistoryCounts,
  HistoryDeleteAuthorityFailure,
  HistoryDeleteCommand,
  HistoryDeleteFailureCode,
  HistoryDeleteOutcome,
  HistoryDeletePreview,
  HistoryDeleteResult,
  HistoryExportCaptureMode,
  HistoryExportCommand,
  HistoryExportFailure,
  HistoryExportFailureCode,
  HistoryExportManifestSummary,
  HistoryExportOutcome,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
  PersistenceAuthorityId,
  PersistenceAuthorityProjection,
  PersistenceProjection,
} from "./history-contract.js";

export type {
  HistoryAcknowledgeResult,
  HistoryCommand,
  HistoryCommandHandler,
  HistoryCommandResult,
  HistoryCounts,
  HistoryDeleteAuthorityFailure,
  HistoryDeleteCommand,
  HistoryDeleteFailureCode,
  HistoryDeleteOutcome,
  HistoryDeletePreview,
  HistoryDeleteResult,
  HistoryExportCaptureMode,
  HistoryExportCommand,
  HistoryExportFailure,
  HistoryExportFailureCode,
  HistoryExportManifestSummary,
  HistoryExportOutcome,
  HistoryExportResult,
  HistoryQueryResult,
  HistoryRange,
  PersistenceAuthorityId,
  PersistenceAuthorityProjection,
  PersistenceProjection,
};
export { PERSISTENCE_AUTHORITY_IDS } from "./history-contract.js";

export type {
  AttentionCategory,
  AttentionCondition,
  AttentionPage,
  AttentionProjection,
  RecentRequestFailures,
} from "./attention-contract.js";
export { RECENT_REQUEST_FAILURE_WINDOW_MS } from "./attention-contract.js";

export type {
  BackupCommand,
  BackupCommandHandler,
  BackupCreateCommand,
  BackupFailure,
  BackupFailureCode,
  BackupManifestEntrySummary,
  BackupManifestSummary,
  BackupMode,
  BackupResult,
  CompatibilityIssue,
  RecoveryProjection,
} from "./backup-contract.js";

export type {
  CaptureDraft,
  CaptureEvent,
  CaptureEventFact,
  CaptureFailureDraft,
  CapturePersistedState,
  CaptureQuery,
  CaptureQueryResult,
  CaptureRangeQuery,
  CaptureRangeQueryResult,
  CaptureRecord,
  CaptureState,
  CaptureTimingEntry,
  CaptureWriteFailure,
  ControlPlaneCapture,
  DeepCaptureStore,
  DeepCaptureStoreFactory,
} from "./capture-contract.js";
export {
  CAPTURE_STATES,
  assertCaptureState,
} from "./capture-contract.js";

export type HelloResult =
  | {
      readonly type: "compatible";
      readonly application: ApplicationIdentity;
      readonly contractVersion: 1;
    }
  | {
      readonly type: "incompatible";
      readonly requestedVersion: number;
      readonly supportedVersions: readonly [1];
    };

export interface ControlPlaneDisconnect {
  readonly reason: "closed" | "transport_lost";
}

export interface RunningControlPlane {
  readonly endpoint: ControlPlaneEndpoint;
  publishStatus(status: ApplicationStatus): Promise<void>;
  close(): Promise<void>;
}

export type RuntimeCommand = "start" | "stop" | "restart";

export type RuntimeCommandConflictCode =
  | "restart_requires_running"
  | "application_restart_required"
  | "runtime_unavailable";

export interface RuntimeCommandConflict {
  readonly code: RuntimeCommandConflictCode;
  readonly message: string;
}

export type RuntimeCommandOutcome =
  "completed" | "unchanged" | "failed" | "conflict";

export interface RuntimeCommandExecution {
  readonly outcome: RuntimeCommandOutcome;
  readonly conflict?: RuntimeCommandConflict;
}

export interface RuntimeCommandResult extends RuntimeCommandExecution {
  readonly command: RuntimeCommand;
  readonly snapshot: StatusSnapshot;
}

export type RuntimeStatusPublisher = (
  status: ApplicationStatus,
) => Promise<void>;

export type RuntimeCommandHandler = (
  command: RuntimeCommand,
  publishStatus: RuntimeStatusPublisher,
) => Promise<RuntimeCommandExecution>;

/** Handles Settings commands and returns a closed outcome plus the settings
 *  projection. The host owns the snapshot merge and the settings_changed
 *  event; it publishes only when an outcome actually changes state. */
export type SettingsCommandHandler = (command: SettingsCommand) => Promise<{
  readonly outcome: SettingsCommandOutcome;
  readonly error?: string;
  readonly confirmation?: LanConfirmation;
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
}>;

/** Handles models.json catalog commands and returns a closed outcome plus
 *  the authoritative file state. The host owns the snapshot merge and the
 *  status publish on state-changing outcomes. */
export type ModelsCommandHandler = (
  command: ModelsCommand,
) => Promise<ModelsCommandResult>;

/** Handles versioned Credential commands against the live authority. */
export type CredentialCommandHandler = (
  command: CredentialCommand,
) => Promise<CredentialCommandResult>;

/** Live settings projection merged into every published status snapshot. */
export interface SettingsProjection {
  readonly settings: Readonly<Record<string, RegisteredSetting>>;
  readonly confirmation?: LanConfirmation;
}

export type ApplicationCommand =
  | { readonly command: "attach" }
  | { readonly command: "quit"; readonly acknowledged: boolean }
  | {
      readonly command: "auto_start";
      readonly action: "status" | "enable" | "disable";
    };

export type ApplicationCommandOutcome =
  | "attached"
  | "drained"
  | "timed_out"
  | "conflict"
  | "ok"
  | "failed"
  | "unsupported";

export type ApplicationCommandConflictCode =
  "quit_requires_explicit_confirmation";

export interface ApplicationCommandConflict {
  readonly code: ApplicationCommandConflictCode;
  readonly message: string;
}

/** Effective Windows login auto-start registration status. */
export interface AutoStartRegistration {
  readonly enabled: boolean;
}

export interface ApplicationCommandExecution {
  readonly outcome: ApplicationCommandOutcome;
  readonly conflict?: ApplicationCommandConflict;
  readonly autoStart?: AutoStartRegistration;
  readonly error?: string;
}

export interface ApplicationCommandResult extends ApplicationCommandExecution {
  readonly command: "attach" | "quit" | "auto_start";
  readonly snapshot: StatusSnapshot;
}

export type ApplicationCommandHandler = (
  command: ApplicationCommand,
  publishStatus: RuntimeStatusPublisher,
) => Promise<ApplicationCommandExecution>;

/** Notified after an application command result frame has been written to
 *  the requesting connection (Ticket 05): the outcome is visible to the
 *  client before the owner process tears down and exits. */
export type ApplicationCommandResultDeliveredHandler = (
  command: ApplicationCommand,
  result: ApplicationCommandResult,
) => Promise<void> | void;

export interface ControlPlaneClient {
  readonly disconnected: Promise<ControlPlaneDisconnect>;
  hello(version: number): Promise<HelloResult>;
  getStatus(): Promise<StatusSnapshot>;
  executeRuntimeCommand(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  executeSettingsCommand(
    command: SettingsCommand,
  ): Promise<SettingsCommandResult>;
  executeApplicationCommand(
    command: ApplicationCommand,
  ): Promise<ApplicationCommandResult>;

  executeClientTokenCommand(
    command: ClientTokenCommand,
  ): Promise<ClientTokenCommandResult>;

  executeCredentialCommand(
    command: CredentialCommand,
  ): Promise<CredentialCommandResult>;

  /** Ticket 13: run a versioned Provider-auth command; interaction events
   *  of an in-flight login are delivered to `onInteraction` until the
   *  command resolves with its terminal outcome. Prompt responses and
   *  cancellation are sent with `respondAuthInteraction`. */
  executeAuthCommand(
    command: AuthCommand,
    onInteraction?: (event: AuthInteractionEvent) => void,
  ): Promise<AuthCommandResult>;

  /** Ticket 13: send a prompt response or cancellation into the one
   *  in-flight login flow of this connection. Rejects when no login is
   *  pending or the response is invalid. */
  respondAuthInteraction(response: AuthInteractionResponse): Promise<void>;

  getRequestIdentities(): Promise<RequestIdentitiesQueryResult>;
  executeModelsCommand(command: ModelsCommand): Promise<ModelsCommandResult>;
  executeCatalogCommand(command: CatalogCommand): Promise<CatalogCommandResult>;
  executeAliasCommand(command: AliasCommand): Promise<AliasCommandResult>;
  executeCodexIntegrationCommand(
    command: CodexIntegrationCommand,
  ): Promise<CodexIntegrationCommandResult>;
  /** Ticket 18: bounded Request Ledger query (newest-first, pageable). */
  getRequestLedger(
    query?: RequestLedgerQuery,
  ): Promise<RequestLedgerQueryResult>;
  /** Ticket 21: bounded, versioned analytics aggregation over the Request
   *  Ledger, computed at query time (summary and options commands). The
   *  host result is strictly re-decoded at the client boundary. */
  getAnalytics(
    query: AnalyticsQuery,
  ): Promise<AnalyticsResult | AnalyticsOptionsResult>;
  /** Ticket 18: opt-in typed ledger events; never delivered to status or
   *  diagnostics subscribers. */
  subscribeRequestLedger(
    listener: (event: RequestLedgerEvent) => void,
  ): Promise<() => Promise<void>>;
  /** Ticket 22: one bounded capture query by the Ticket 18 request id. */
  getCapture(query: CaptureQuery): Promise<CaptureQueryResult>;
  /** Ticket 22: opt-in typed capture-state events (narrow facts only);
   *  never delivered to status, diagnostics, or ledger subscribers. */
  subscribeCapture(
    listener: (event: CaptureEvent) => void,
  ): Promise<() => Promise<void>>;
  /** Ticket 23: per-authority eligible-record counts over one history range
   *  (the preview used by export and irreversible deletion gates). */
  queryHistory(range?: HistoryRange): Promise<HistoryQueryResult>;
  /** Ticket 23: start (or gate) one versioned history export. A sensitive
   *  capture-included export returns confirmation_required; an excluded
   *  export runs immediately. */
  executeHistoryExport(
    command: HistoryExportCommand,
  ): Promise<HistoryExportResult>;
  /** Ticket 23: executes the single-use sensitive export confirmation. */
  confirmHistoryExport(actionId: string): Promise<HistoryExportResult>;
  /** Ticket 23: gates an irreversible range/all deletion behind a count
   *  preview confirmation. */
  executeHistoryDelete(command: HistoryDeleteCommand): Promise<HistoryDeleteResult>;
  /** Ticket 23: executes the single-use irreversible deletion confirmation. */
  confirmHistoryDelete(actionId: string): Promise<HistoryDeleteResult>;
  /** Ticket 23: acknowledges the audit-unavailable state. Acknowledgment
   *  only silences the urgent presentation; it never claims storage
   *  recovered and never clears an authority that is still failing. */
  acknowledgePersistence(): Promise<HistoryAcknowledgeResult>;
  /** Ticket 24: create an ordinary backup immediately or request the
   * explicit full-sensitive confirmation gate. */
  executeBackup(command: BackupCreateCommand): Promise<BackupResult>;
  /** Ticket 24: execute the single-use full-sensitive backup gate. */
  confirmBackup(actionId: string): Promise<BackupResult>;
  getDiagnostics(
    query?: RuntimeDiagnosticQuery,
  ): Promise<RuntimeDiagnosticsQueryResult>;
  subscribeDiagnostics(
    listener: (event: RuntimeDiagnosticEvent) => void,
  ): Promise<() => Promise<void>>;
  subscribe(
    listener: (event: StatusEvent) => void,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export function assertControlPlaneEndpoint(
  endpoint: ControlPlaneEndpoint,
): void {
  if (
    !endpoint.pipeName.startsWith("\\\\.\\pipe\\") ||
    endpoint.pipeName.length <= "\\\\.\\pipe\\".length ||
    endpoint.capability.length < 32
  ) {
    throw new Error("Invalid local Control Plane endpoint");
  }
}
