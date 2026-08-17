/**
 * Ticket 12 — the single serialized Credential Authority.
 *
 * One live authority owns every Provider's one stored auth.json slot. All
 * mutations (confirmed replacement, logout, Provider-by-Provider import)
 * run through one lock/revision/atomic-publish path:
 *
 * - every command refreshes the authoritative file state first (external
 *   edits become a new revision immediately) and rejects stale clients with
 *   an explicit conflict;
 * - every write is a compare-and-swap on the slot the client was served,
 *   executed inside the file lock (`casWrite`), so UI and CLI can never
 *   lose a concurrent update;
 * - import is confirmed Provider by Provider: the preview validates the
 *   Pi-compatible payload strictly and reports which entries would
 *   overwrite, the apply writes only the selected Providers with the
 *   previewed baseline as the CAS generation, and unselected existing
 *   credentials are preserved byte-for-byte.
 *
 * Status exposes only bounded structural facts (stored / environment /
 * models.json / command-derived / expired / unavailable / effective
 * source). Credential values, environment-variable names, command text,
 * headers and raw credential objects never leave this module. The
 * `!command` / `$ENV` / literal classification reuses the Ticket 10
 * config-value resolver (no parser is duplicated) and no status evaluation
 * ever executes a configured command.
 */
import { randomUUID } from "node:crypto";

import type {
  AuthContext,
  Credential,
  CredentialInfo,
  CredentialStore,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  CredentialCommandResult,
  CredentialFileError,
  CredentialImportApplyEntryResult,
  CredentialProjection,
  ProviderAuthStatus,
} from "@luckytoken/application-control-plane/control-plane";
import type { ModelsJsonProviderConfig } from "../providers/models-json.js";
import type { ConfigValueResolver } from "../providers/config-value.js";
import {
  CredentialFileShapeError,
  CredentialFileSyntaxError,
  CredentialStaleSlotError,
  credentialsEqual,
  parseCredentialFile,
} from "../pi/file-credential-store.js";

export { CredentialStaleSlotError } from "../pi/file-credential-store.js";

/** Store capability the authority needs beyond the Pi contract: the raw
 *  snapshot for revision/status and the serialized per-slot CAS write. */
export interface CredentialAuthorityStore extends CredentialStore {
  snapshot(): Promise<{
    readonly raw: string;
    readonly data: Readonly<Record<string, Credential>>;
    readonly present: boolean;
  }>;
  casWrite(
    providerId: string,
    expected: Credential | undefined,
    next: Credential | undefined,
  ): Promise<void>;
}

/**
 * Adapts any Pi CredentialStore to the authority's store capability.
 * Stores that already implement `snapshot`/`casWrite` (the LuckyToken file
 * store) are used as-is; generic stores (e.g. pi-ai's in-memory store used
 * by tests) get an in-process snapshot and a per-provider serialized CAS
 * wrapper over the Pi contract.
 */
export function createCredentialAuthorityStore(
  store: CredentialStore,
): CredentialAuthorityStore {
  const candidate = store as Partial<CredentialAuthorityStore>;
  if (
    typeof candidate.snapshot === "function" &&
    typeof candidate.casWrite === "function"
  ) {
    return store as CredentialAuthorityStore;
  }
  const chains = new Map<string, Promise<unknown>>();
  const enqueue = <T>(
    providerId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    chains.set(
      providerId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  };
  const wrapped: CredentialAuthorityStore = Object.freeze({
    read: (providerId: string) => store.read(providerId),
    list: () => store.list(),
    modify: (
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ) => store.modify(providerId, fn),
    delete: (providerId: string) => store.delete(providerId),
    snapshot: async () => {
      const listed: readonly CredentialInfo[] = await store.list();
      const data: Record<string, Credential> = {};
      for (const info of listed) {
        const credential = await store.read(info.providerId);
        if (credential !== undefined) data[info.providerId] = credential;
      }
      return { raw: JSON.stringify(data), data, present: true };
    },
    casWrite: async (
      providerId: string,
      expected: Credential | undefined,
      next: Credential | undefined,
    ) => {
      if (next !== undefined) {
        await store.modify(providerId, async (current) => {
          if (!credentialsEqual(current, expected)) {
            throw new CredentialStaleSlotError();
          }
          return next;
        });
        return;
      }
      await enqueue(providerId, async () => {
        const current = await store.read(providerId);
        if (!credentialsEqual(current, expected)) {
          throw new CredentialStaleSlotError();
        }
        await store.delete(providerId);
      });
    },
  });
  return wrapped;
}

export interface LiveCredentialAuthorityOptions {
  /** The Pi contract store; production uses the LuckyToken auth.json store. */
  readonly store: CredentialStore;
  /** auth.json location reported in projections (file facts only). */
  readonly path: string;
  /** Ticket 10 resolver: literal / `$ENV` / `!command` semantics. */
  readonly configValues: ConfigValueResolver;
  /** Environment lookups for status; never executes commands. */
  readonly authContext: AuthContext;
  /** The composed Provider catalog (ambient auth checks). */
  readonly providers: () => readonly Provider[];
  /** The composition's parsed models.json providers (apiKey declarations). */
  readonly modelsJsonProviders: () => Readonly<
    Record<string, ModelsJsonProviderConfig>
  >;
  readonly now?: () => number;
}

export interface LiveCredentialAuthority {
  /** Refresh from disk and return the authoritative command result. */
  query(): Promise<CredentialCommandResult>;
  /** Sanitized current projection; never refreshes. */
  snapshot(): CredentialProjection;
  login(input: {
    readonly providerId: string;
    readonly expectedRevision: number;
    readonly value: string;
    readonly overwrite: boolean;
  }): Promise<CredentialCommandResult>;
  logout(input: {
    readonly providerId: string;
    readonly expectedRevision: number;
  }): Promise<CredentialCommandResult>;
  importPreview(input: {
    readonly expectedRevision: number;
    readonly content: string;
  }): Promise<CredentialCommandResult>;
  importApply(input: {
    readonly expectedRevision: number;
    readonly importId: string;
    readonly selections: readonly {
      readonly providerId: string;
      readonly overwrite: boolean;
    }[];
  }): Promise<CredentialCommandResult>;
  /** Narrow known-value scrub (Ticket 07 F4) over owned stored values;
   *  includes env-resolved values of non-command references; never executes
   *  commands. */
  scrub(value: string): string;
}

interface ImportSession {
  readonly importId: string;
  readonly revision: number;
  readonly data: Readonly<Record<string, Credential>>;
  readonly expected: Readonly<Map<string, Credential | undefined>>;
}

function fileErrorKind(error: unknown): CredentialFileError["kind"] {
  if (error instanceof CredentialFileSyntaxError) return "parse";
  if (error instanceof CredentialFileShapeError) return "invalid";
  return "load";
}

function fileErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function createLiveCredentialAuthority(
  options: LiveCredentialAuthorityOptions,
): Promise<LiveCredentialAuthority> {
  const store = createCredentialAuthorityStore(options.store);
  const now = options.now ?? Date.now;
  const path = options.path;
  let revision = 0;
  let diskRaw = "";
  let diskPresent = false;
  // Last-good parsed stored credentials (raw, unresolved).
  let stored = new Map<string, Credential>();
  let projection: CredentialProjection = Object.freeze({
    revision,
    path,
    present: false,
    valid: false,
    providers: Object.freeze([]),
  });
  let scrubPattern: RegExp | undefined;
  let importSession: ImportSession | undefined;
  // Serializes refresh/build cycles so concurrent commands never observe a
  // half-refreshed projection or double-count a revision.
  let refreshChain = Promise.resolve();
  const withRefresh = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = refreshChain.then(operation, operation);
    refreshChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const refresh = async (): Promise<void> => {
    let raw: string;
    let present = true;
    let fileError: CredentialFileError | undefined;
    let parsed: Readonly<Record<string, Credential>> | undefined;
    try {
      const snapshot = await store.snapshot();
      raw = snapshot.raw;
      present = snapshot.present;
      parsed = snapshot.data;
    } catch (error) {
      raw = "";
      fileError = Object.freeze({
        kind: fileErrorKind(error),
        message: fileErrorMessage(error),
      });
    }
    if (present !== diskPresent || raw !== diskRaw) {
      diskPresent = present;
      diskRaw = raw;
      revision += 1;
    }
    if (fileError !== undefined) {
      // Malformed or unreadable file: no stored facts are claimed and the
      // value-free error is exposed; mutations fail explicitly elsewhere.
      // The last-good in-memory known-value scrub state is retained so
      // diagnostics stay protected from secrets that were stored before
      // the file broke — the values are never persisted or projected.
      projection = Object.freeze({
        revision,
        path,
        present: diskPresent,
        valid: false,
        error: fileError,
        providers: Object.freeze([]),
      });
      return;
    }
    const nextStored = new Map<string, Credential>();
    if (parsed !== undefined) {
      for (const [providerId, credential] of Object.entries(parsed)) {
        nextStored.set(providerId, credential);
      }
    }
    const changedStored =
      nextStored.size !== stored.size ||
      [...nextStored.entries()].some(
        ([providerId, credential]) =>
          !credentialsEqual(stored.get(providerId), credential),
      );
    stored = nextStored;
    if (changedStored) scrubPattern = undefined;
    projection = await buildProjection();
  };

  /** One bounded status row; side-effect free (env lookups and ambient
   *  checks only — configured commands are classified, never executed). */
  const buildStatusRow = async (
    providerId: string,
    credential: Credential | undefined,
  ): Promise<ProviderAuthStatus> => {
    const config = options.modelsJsonProviders()[providerId];
    const rawKey = config?.apiKey;
    const modelsJson = rawKey !== undefined;
    const commandDerived =
      modelsJson && options.configValues.isCommandConfigValue(rawKey as string);
    // Request-time precedence (pinned): a stored credential wins when it
    // resolves; an unresolvable stored reference falls through to the
    // ambient source (models.json is never consulted while a stored slot
    // exists). Environment lookups are side-effect free; `!command`
    // sources are classified without ever executing them.
    let storedEffective = false;
    if (credential !== undefined) {
      if (credential.type === "oauth") {
        storedEffective = true;
      } else if (credential.key === undefined) {
        storedEffective = false;
      } else if (options.configValues.isCommandConfigValue(credential.key)) {
        storedEffective = true;
      } else {
        storedEffective = true;
        for (const name of options.configValues.getEnvVarNames(
          credential.key,
        )) {
          if ((await options.authContext.env(name)) === undefined) {
            storedEffective = false;
            break;
          }
        }
      }
    }
    let environment = false;
    let configuredResolvable = true;
    if (!storedEffective) {
      if (credential !== undefined) {
        // Stored slot exists but its reference cannot resolve: the request
        // path falls to the inherited (ambient) source only — models.json
        // is never consulted while a stored slot exists. The check runs
        // with the keyless stored credential so composed auth resolves
        // through the same ambient path (no command is ever executed).
        const provider = options
          .providers()
          .find((entry) => entry.id === providerId);
        if (provider?.auth.apiKey !== undefined) {
          try {
            const check = await provider.auth.apiKey.check?.({
              ctx: options.authContext,
              credential: { type: "api_key" },
              signal: new AbortController().signal,
            });
            environment = check !== undefined;
          } catch {
            environment = false;
          }
        }
      } else if (modelsJson) {
        if (!commandDerived) {
          for (const name of options.configValues.getEnvVarNames(
            rawKey as string,
          )) {
            if ((await options.authContext.env(name)) === undefined) {
              configuredResolvable = false;
              break;
            }
          }
        }
      } else {
        const provider = options
          .providers()
          .find((entry) => entry.id === providerId);
        if (provider?.auth.apiKey !== undefined) {
          try {
            const check = await provider.auth.apiKey.check?.({
              ctx: options.authContext,
              signal: new AbortController().signal,
            });
            environment = check !== undefined;
          } catch {
            environment = false;
          }
        }
      }
    }
    const effectiveSource: ProviderAuthStatus["effectiveSource"] =
      storedEffective
        ? "stored"
        : credential !== undefined
          ? environment
            ? "environment"
            : "none"
          : modelsJson
            ? commandDerived
              ? "command"
              : configuredResolvable
                ? "models.json"
                : "none"
            : environment
              ? "environment"
              : "none";
    const storedType = credential === undefined ? undefined : credential.type;
    const expired = credential?.type === "oauth" && credential.expires <= now();
    return Object.freeze({
      providerId,
      stored: credential !== undefined,
      ...(storedType === undefined ? {} : { storedType }),
      environment,
      modelsJson,
      commandDerived,
      expired,
      unavailable: effectiveSource === "none",
      effectiveSource,
    });
  };

  const buildProjection = async (): Promise<CredentialProjection> => {
    const catalog = options.providers();
    const rows: ProviderAuthStatus[] = [];
    const seen = new Set<string>();
    for (const provider of catalog) {
      seen.add(provider.id);
      rows.push(await buildStatusRow(provider.id, stored.get(provider.id)));
    }
    for (const providerId of [...stored.keys()].sort()) {
      if (seen.has(providerId)) continue;
      rows.push(await buildStatusRow(providerId, stored.get(providerId)));
    }
    return Object.freeze({
      revision,
      path,
      present: diskPresent,
      valid: diskPresent,
      providers: Object.freeze(rows),
    });
  };

  const result = (
    outcome: CredentialCommandResult["outcome"],
    extra: Partial<CredentialCommandResult> = {},
  ): CredentialCommandResult =>
    Object.freeze({
      outcome,
      revision,
      state: projection,
      ...extra,
    });

  const rebuildScrubPattern = (): void => {
    const values: string[] = [];
    for (const credential of stored.values()) {
      if (credential.type === "api_key") {
        if (credential.key !== undefined) values.push(credential.key);
        if (credential.env !== undefined) {
          values.push(...Object.values(credential.env));
        }
        // Env-resolved values of non-command references (safe lookups only;
        // commands are never executed for scrubbing).
        if (
          credential.key !== undefined &&
          !options.configValues.isCommandConfigValue(credential.key)
        ) {
          try {
            const resolved = options.configValues.resolveValueOrThrow(
              credential.key,
              "stored credential",
            );
            if (resolved !== credential.key) values.push(resolved);
          } catch {
            // Unresolvable reference: nothing to scrub.
          }
        }
      } else {
        values.push(credential.access, credential.refresh);
      }
    }
    const unique = [...new Set(values)].filter((value) => value.length > 0);
    scrubPattern =
      unique.length === 0
        ? undefined
        : new RegExp(unique.map(escapePattern).join("|"), "gu");
  };

  const live: LiveCredentialAuthority = Object.freeze({
    query(): Promise<CredentialCommandResult> {
      return withRefresh(async () => {
        await refresh();
        return result("ok");
      });
    },
    snapshot(): CredentialProjection {
      return projection;
    },
    login(
      input: Parameters<LiveCredentialAuthority["login"]>[0],
    ): Promise<CredentialCommandResult> {
      return withRefresh(async () => {
        await refresh();
        if (input.expectedRevision !== revision) {
          return result("conflict", {
            error: "Credential state changed; re-query and retry",
          });
        }
        if (input.value.trim().length === 0) {
          return result("invalid", {
            error: "API key value must be non-empty",
          });
        }
        const provider = options
          .providers()
          .find((entry) => entry.id === input.providerId);
        if (provider === undefined) {
          return result("unknown_provider", {
            error: `Unknown Provider: ${input.providerId}`,
          });
        }
        if (provider.auth.apiKey === undefined) {
          return result("invalid", {
            error: `Provider ${input.providerId} does not support API key login`,
          });
        }
        const expected = stored.get(input.providerId);
        if (!input.overwrite && expected !== undefined) {
          return result("overwrite_required", {
            error: `Provider ${input.providerId} already has a stored credential; confirm the replacement`,
          });
        }
        try {
          await store.casWrite(input.providerId, expected, {
            type: "api_key",
            key: input.value,
          });
        } catch (error) {
          if (error instanceof CredentialStaleSlotError) {
            return result("conflict", {
              error: "Credential state changed; re-query and retry",
            });
          }
          if (
            error instanceof CredentialFileSyntaxError ||
            error instanceof CredentialFileShapeError
          ) {
            return result("conflict", {
              error: `auth.json is malformed and was not modified: ${fileErrorMessage(error)}`,
            });
          }
          return result("storage_failure", {
            error: `Failed to store the credential: ${fileErrorMessage(error)}`,
          });
        }
        await refresh();
        return result("ok", { changed: true });
      });
    },
    logout(
      input: Parameters<LiveCredentialAuthority["logout"]>[0],
    ): Promise<CredentialCommandResult> {
      return withRefresh(async () => {
        await refresh();
        if (input.expectedRevision !== revision) {
          return result("conflict", {
            error: "Credential state changed; re-query and retry",
          });
        }
        const expected = stored.get(input.providerId);
        // Logging out an empty slot must not create auth.json: nothing was
        // stored and the file does not exist yet, so no state changes.
        if (expected === undefined && !diskPresent) {
          return result("ok", { changed: false });
        }
        try {
          await store.casWrite(input.providerId, expected, undefined);
        } catch (error) {
          if (error instanceof CredentialStaleSlotError) {
            return result("conflict", {
              error: "Credential state changed; re-query and retry",
            });
          }
          if (
            error instanceof CredentialFileSyntaxError ||
            error instanceof CredentialFileShapeError
          ) {
            return result("conflict", {
              error: `auth.json is malformed and was not modified: ${fileErrorMessage(error)}`,
            });
          }
          return result("storage_failure", {
            error: `Failed to remove the credential: ${fileErrorMessage(error)}`,
          });
        }
        await refresh();
        return result("ok", { changed: expected !== undefined });
      });
    },
    importPreview(
      input: Parameters<LiveCredentialAuthority["importPreview"]>[0],
    ): Promise<CredentialCommandResult> {
      return withRefresh(async () => {
        await refresh();
        if (input.expectedRevision !== revision) {
          return result("conflict", {
            error: "Credential state changed; re-query and retry",
          });
        }
        let data: Readonly<Record<string, Credential>>;
        try {
          data = parseCredentialFile(input.content);
        } catch (error) {
          return result("invalid", {
            error: `Invalid auth.json import: ${fileErrorMessage(error)}`,
          });
        }
        const importId = randomUUID();
        const expected = new Map<string, Credential | undefined>();
        for (const providerId of Object.keys(data)) {
          expected.set(providerId, stored.get(providerId));
        }
        importSession = Object.freeze({
          importId,
          revision,
          data,
          expected,
        });
        return result("ok", {
          importId,
          previewEntries: Object.freeze(
            Object.entries(data).map(([providerId, credential]) =>
              Object.freeze({
                providerId,
                type: credential.type,
                wouldOverwrite: stored.get(providerId) !== undefined,
              }),
            ),
          ),
        });
      });
    },
    importApply(
      input: Parameters<LiveCredentialAuthority["importApply"]>[0],
    ): Promise<CredentialCommandResult> {
      return withRefresh(async () => {
        await refresh();
        const session = importSession;
        if (session === undefined || session.importId !== input.importId) {
          return result("conflict", {
            error:
              "Import preview is no longer valid; re-run the import to confirm",
          });
        }
        // The client must echo the preview it confirmed. Post-preview
        // changes are not a coarse gate here: every selected slot is
        // compare-and-swapped against the previewed baseline, so a
        // concurrent UI/CLI mutation conflicts per entry instead of being
        // silently overwritten (and unselected changes are preserved).
        if (input.expectedRevision !== session.revision) {
          return result("conflict", {
            error: "Credential state changed; re-query and retry",
          });
        }
        const seenSelections = new Set<string>();
        for (const selection of input.selections) {
          if (
            seenSelections.has(selection.providerId) ||
            !(selection.providerId in session.data)
          ) {
            return result("invalid", {
              error: `Import selection is not in the previewed file: ${selection.providerId}`,
            });
          }
          seenSelections.add(selection.providerId);
        }
        // The preview session is single-use: it is consumed by this apply.
        importSession = undefined;
        const entries: CredentialImportApplyEntryResult[] = [];
        let conflicted = false;
        for (const selection of input.selections) {
          const expected = session.expected.get(selection.providerId);
          if (!selection.overwrite && expected !== undefined) {
            // The user explicitly declined this overwrite: the existing
            // credential is preserved and the entry reports `skipped` —
            // never a failure that blocks the confirmed entries.
            entries.push(
              Object.freeze({
                providerId: selection.providerId,
                outcome: "skipped" as const,
              }),
            );
            continue;
          }
          const next = session.data[selection.providerId];
          if (credentialsEqual(expected, next)) {
            entries.push(
              Object.freeze({
                providerId: selection.providerId,
                outcome: "unchanged" as const,
              }),
            );
            continue;
          }
          try {
            await store.casWrite(selection.providerId, expected, next);
            entries.push(
              Object.freeze({
                providerId: selection.providerId,
                outcome: "applied" as const,
              }),
            );
          } catch (error) {
            if (error instanceof CredentialStaleSlotError) {
              conflicted = true;
              entries.push(
                Object.freeze({
                  providerId: selection.providerId,
                  outcome: "conflict" as const,
                }),
              );
              continue;
            }
            if (
              error instanceof CredentialFileSyntaxError ||
              error instanceof CredentialFileShapeError
            ) {
              conflicted = true;
              entries.push(
                Object.freeze({
                  providerId: selection.providerId,
                  outcome: "conflict" as const,
                }),
              );
              continue;
            }
            return result("storage_failure", {
              error: `Failed to import credentials: ${fileErrorMessage(error)}`,
            });
          }
        }
        await refresh();
        if (conflicted) {
          return result("conflict", {
            error:
              "One or more stored credentials changed while the import was confirmed; the remaining entries were applied",
            entries,
          });
        }
        return result("ok", { entries });
      });
    },
    scrub(value: string): string {
      if (scrubPattern === undefined) rebuildScrubPattern();
      return scrubPattern === undefined
        ? value
        : value.replace(scrubPattern, "[REDACTED]");
    },
  });
  return (async () => {
    try {
      await withRefresh(() => refresh());
    } catch {
      // A failed initial refresh is reflected in the projection; creation
      // never rejects on a malformed or unreadable file.
    }
    return live;
  })();
}
