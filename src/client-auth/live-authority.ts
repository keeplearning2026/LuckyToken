import { randomBytes } from "node:crypto";

import type { AuthorizedClient } from "../auth.js";
import {
  ClientTokenStaleRevisionError,
  type FileClientTokenStore,
} from "./file-token-store.js";

export { ClientTokenStaleRevisionError } from "./file-token-store.js";

/**
 * Live protocol-global Client Token Authority (Ticket 16).
 *
 * One live authority per Client Protocol owns the one active global token.
 * All mutations are serialized through a lock, carry the expected revision
 * from a prior list, persist atomically through the file store, and
 * hot-apply to the in-memory authorization state before they return. The
 * authority is the single in-process writer, so UI and CLI mutations that
 * arrive through the Control Plane can never lose an update or resurrect an
 * old token. Project tokens stay readable and authorizable for Ticket 17;
 * this ticket manages only the global scope.
 *
 * The file is authoritative for both the mutation revision (a stale client
 * revision can never match a post-restart reset) and the global-scope
 * lifecycle state: a deliberately deleted token is marked and an ordinary
 * restart never re-creates it; only fresh enabling (never-initialized scope)
 * or a disabled→enabled transition may create.
 */

export interface MaskedClientTokenScope {
  readonly type: "global" | "project";
  readonly projectDir?: string;
  readonly maskedToken: string;
}

export interface ClientTokenAuthorityListing {
  readonly revision: number;
  readonly scopes: readonly MaskedClientTokenScope[];
}

export class ClientTokenScopeNotFoundError extends Error {
  readonly code = "SCOPE_NOT_FOUND" as const;

  constructor() {
    super("Client token scope does not exist");
    this.name = "ClientTokenScopeNotFoundError";
  }
}

export class ClientTokenInvalidValueError extends Error {
  readonly code = "INVALID_VALUE" as const;

  constructor(message: string) {
    super(message);
    this.name = "ClientTokenInvalidValueError";
  }
}

export interface LiveClientTokenAuthorityOptions {
  readonly store: FileClientTokenStore;
  readonly generateToken?: () => string;
}

export interface LiveClientTokenAuthority {
  /** Current mutation revision; list results and conflicts carry it. */
  readonly revision: number;
  /**
   * Creates exactly one global token when the scope has none. With
   * `freshOnly` the scope must never have been initialized: an ordinary
   * restart after a deliberate delete never re-creates the token, while the
   * disabled→enabled transition (no `freshOnly`) may.
   */
  ensureGlobal(options?: { readonly freshOnly?: boolean }): Promise<boolean>;
  list(): Promise<ClientTokenAuthorityListing>;
  /** Explicit local operation: returns only the active global secret. */
  reveal(): Promise<string>;
  rotate(expectedRevision: number, token?: string): Promise<ClientTokenAuthorityListing>;
  remove(expectedRevision: number): Promise<ClientTokenAuthorityListing>;
  authorize(token: string): AuthorizedClient | undefined;
  /** Narrow known-value scrub capability (Ticket 07 F4) over the current
   *  owned token values; follows rotate/remove/ensure live. */
  scrub(value: string): string;
}

/** Masked form always carries the mask marker so wire decoders can reject a
 *  raw token that ever reaches a masked field. */
export function maskClientToken(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function createLiveClientTokenAuthority(
  options: LiveClientTokenAuthorityOptions,
): Promise<LiveClientTokenAuthority> {
  const generateToken =
    options.generateToken ?? (() => `lt_${randomBytes(32).toString("base64url")}`);
  let globalToken: string | undefined;
  let globalDeleted = false;
  let projectTokens = new Map<string, string>();
  let revision = 0;
  let scrubPattern: RegExp | undefined;
  let lock = Promise.resolve();

  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lock.then(operation, operation);
    lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const refresh = async (): Promise<void> => {
    const snapshot = await options.store.snapshot();
    globalToken = snapshot.global ?? undefined;
    globalDeleted = snapshot.globalDeleted;
    projectTokens = new Map(Object.entries(snapshot.projects));
    revision = snapshot.revision;
    scrubPattern = undefined;
  };

  /** The authoritative file rejected a stale CAS: converge the in-memory
   *  mirror with the persisted state before rethrowing. */
  const convergeOnStale = async (): Promise<void> => {
    await refresh().catch(() => undefined);
  };

  const listing = (): ClientTokenAuthorityListing => {
    const scopes: MaskedClientTokenScope[] = [];
    if (globalToken !== undefined) {
      scopes.push({
        type: "global",
        maskedToken: maskClientToken(globalToken),
      });
    }
    for (const projectDir of [...projectTokens.keys()].sort()) {
      const token = projectTokens.get(projectDir);
      if (token !== undefined) {
        scopes.push({ type: "project", projectDir, maskedToken: maskClientToken(token) });
      }
    }
    return Object.freeze({ revision, scopes: Object.freeze(scopes) });
  };

  const rebuildScrubPattern = (): void => {
    const owned = [
      ...(globalToken === undefined ? [] : [globalToken]),
      ...projectTokens.values(),
    ].filter((token) => token.length > 0);
    scrubPattern =
      owned.length === 0
        ? undefined
        : new RegExp(owned.map(escapePattern).join("|"), "gu");
  };

  const live: LiveClientTokenAuthority = Object.freeze({
    get revision(): number {
      return revision;
    },
    ensureGlobal(ensureOptions?: {
      readonly freshOnly?: boolean;
    }): Promise<boolean> {
      return withLock(async () => {
        if (globalToken !== undefined) return false;
        // A deliberately deleted token is never re-created by an ordinary
        // restart (fresh boot-time enabling). The disabled→enabled
        // transition (no freshOnly) may create in any state.
        if (ensureOptions?.freshOnly === true && globalDeleted) return false;
        try {
          await options.store.create(
            { type: "global" },
            generateToken(),
            revision,
          );
        } catch (error) {
          if (!(error instanceof ClientTokenStaleRevisionError)) throw error;
          // The authoritative file advanced since this mirror (e.g. an
          // offline directory-token CLI write while the app is running):
          // converge and retry the idempotent creation once with the
          // current generation. Creation can never clobber a concurrent
          // mutation.
          await convergeOnStale();
          if (globalToken !== undefined) return false;
          if (ensureOptions?.freshOnly === true && globalDeleted) return false;
          await options.store.create(
            { type: "global" },
            generateToken(),
            revision,
          );
        }
        await refresh();
        return true;
      });
    },
    list(): Promise<ClientTokenAuthorityListing> {
      return withLock(async () => listing());
    },
    reveal(): Promise<string> {
      if (globalToken === undefined) {
        return Promise.reject(new ClientTokenScopeNotFoundError());
      }
      return Promise.resolve(globalToken);
    },
    rotate(
      expectedRevision: number,
      token?: string,
    ): Promise<ClientTokenAuthorityListing> {
      return withLock(async () => {
        if (expectedRevision !== revision) {
          throw new ClientTokenStaleRevisionError();
        }
        if (globalToken === undefined) {
          throw new ClientTokenScopeNotFoundError();
        }
        const replacement = token ?? generateToken();
        if (replacement === globalToken) {
          throw new ClientTokenInvalidValueError(
            "Replacement client token must be different from the current token",
          );
        }
        if ([...projectTokens.values()].includes(replacement)) {
          throw new ClientTokenInvalidValueError(
            "Client token already belongs to another scope",
          );
        }
        // The file store re-validates and persists atomically (the file's
        // revision is the CAS generation); only after a successful persist
        // is the in-memory state hot-applied.
        try {
          await options.store.rotate(
            { type: "global" },
            replacement,
            expectedRevision,
          );
        } catch (error) {
          if (error instanceof ClientTokenStaleRevisionError) {
            await convergeOnStale();
          }
          throw error;
        }
        await refresh();
        return listing();
      });
    },
    remove(expectedRevision: number): Promise<ClientTokenAuthorityListing> {
      return withLock(async () => {
        if (expectedRevision !== revision) {
          throw new ClientTokenStaleRevisionError();
        }
        if (globalToken === undefined) {
          throw new ClientTokenScopeNotFoundError();
        }
        try {
          await options.store.remove({ type: "global" }, expectedRevision);
        } catch (error) {
          if (error instanceof ClientTokenStaleRevisionError) {
            await convergeOnStale();
          }
          throw error;
        }
        await refresh();
        return listing();
      });
    },
    authorize(token: string): AuthorizedClient | undefined {
      if (token === globalToken) return Object.freeze({});
      const projectDir = [...projectTokens.entries()].find(
        ([, value]) => value === token,
      )?.[0];
      return projectDir === undefined
        ? undefined
        : Object.freeze({ projectDir });
    },
    scrub(value: string): string {
      if (scrubPattern === undefined) rebuildScrubPattern();
      return scrubPattern === undefined
        ? value
        : value.replace(scrubPattern, "[REDACTED]");
    },
  });
  // Initial in-memory state mirrors the persisted file exactly once at boot;
  // a corrupted or unreadable file fails creation instead of serving
  // unvalidated state.
  await refresh();
  return live;
}
