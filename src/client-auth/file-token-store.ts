import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";

import lockfile from "proper-lockfile";

import type { AuthorizedClient } from "../auth.js";

const SCHEMA_VERSION = "luckytoken-client-auth-v2";
const LEGACY_SCHEMA_VERSION = "luckytoken-client-auth-v1";
const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;
/** Lock staleness matches the Control Plane descriptor lease pattern. */
const LOCK_STALE_MS = 30_000;
/** Retry budget ≈ the stale window, mirroring the credential store's
 *  deadline pattern: waiters survive brief contention and only give up
 *  after a crashed owner could have been detected as stale. */
const LOCK_RETRIES = 6_000;
const LOCK_MIN_TIMEOUT_MS = 5;
const LOCK_MAX_TIMEOUT_MS = 25;

export class ClientTokenStaleRevisionError extends Error {
  readonly code = "STALE_REVISION" as const;

  constructor() {
    super("Client token revision is stale");
    this.name = "ClientTokenStaleRevisionError";
  }
}

export type ClientTokenScope =
  | { readonly type: "global" }
  | { readonly type: "project"; readonly projectDir: string };

export interface ClientTokenAuthority {
  authorize(token: string): AuthorizedClient | undefined;
  /**
   * Narrow known-value scrub capability (Ticket 07 F4): removes this
   * authority's own raw token values from text. The authority owns the raw
   * values; no broad raw-secret array ever flows through unrelated modules.
   */
  scrub(value: string): string;
}

export interface ClientTokenFileSnapshot {
  readonly global: string | null;
  readonly projects: Readonly<Record<string, string>>;
  /**
   * Monotonic mutation generation persisted in the authoritative file: a
   * stale client's expectedRevision can never match a post-restart reset.
   */
  readonly revision: number;
  /** Explicit marker: the global token was deliberately deleted and must
   *  not be re-created by an ordinary restart (fresh enabling may create). */
  readonly globalDeleted: boolean;
}

export interface FileClientTokenStore {
  /**
   * When expectedRevision is provided the persisted mutation is a
   * compare-and-swap: the file's current revision must match or the write is
   * rejected without mutating anything.
   */
  create(scope: ClientTokenScope, token?: string, expectedRevision?: number): Promise<string>;
  rotate(scope: ClientTokenScope, token?: string, expectedRevision?: number): Promise<string>;
  remove(scope: ClientTokenScope, expectedRevision?: number): Promise<boolean>;
  list(): Promise<readonly ClientTokenScope[]>;
  /** Raw value snapshot for the live authority's in-memory authorization
   *  state (Ticket 16). Only the authority consumes token values. */
  snapshot(): Promise<ClientTokenFileSnapshot>;
}

export interface ClientTokenFileOperations {
  /** Create a private same-directory temporary file for atomic publication. */
  createTemporary(path: string): Promise<FileHandle>;
  /** Durable flush of the temporary file before publication. */
  flush(handle: FileHandle): Promise<void>;
  /** Atomic replace of the target file with the temporary file. */
  replace(from: string, to: string): Promise<void>;
}

const defaultFileOperations: ClientTokenFileOperations = Object.freeze({
  createTemporary: (path: string) => open(path, "wx", AUTH_FILE_MODE),
  flush: (handle: FileHandle) => handle.sync(),
  replace: (from: string, to: string) => rename(from, to),
});

export interface FileClientTokenStoreOptions {
  readonly path: string;
  readonly generateToken?: () => string;
  /**
   * Injectable file primitives (repair turn 2): the persist path publishes
   * through a private temporary file plus atomic replace, and each boundary
   * is independently faultable in tests. Defaults are the real fs
   * operations.
   */
  readonly fileOperations?: ClientTokenFileOperations;
}

interface ClientTokenData {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly global: string | null;
  readonly projects: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly globalDeleted: boolean;
}

function validIdentifier(value: string, description: string): string {
  if (value.length === 0 || /\s/u.test(value)) {
    throw new Error(`${description} must be non-empty and contain no whitespace`);
  }
  return value;
}

function assertNormalizedProjectDir(projectDir: string): void {
  if (!isAbsolute(projectDir)) {
    throw new Error("Project directory must be absolute");
  }
  if (resolve(projectDir) !== projectDir) {
    throw new Error("Project directory must be normalized");
  }
}

function parseData(content: string): ClientTokenData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Invalid client token file: expected valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid client token file: expected an object");
  }
  const value = parsed as Record<string, unknown>;
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Invalid client token file: schemaVersion must be ${SCHEMA_VERSION}`,
    );
  }
  const allowed = new Set([
    "schemaVersion",
    "global",
    "projects",
    "revision",
    "globalDeleted",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid client token file: unknown field ${key}`);
    }
  }
  if (value.global !== null && typeof value.global !== "string") {
    throw new Error("Invalid client token file: global must be a token or null");
  }
  if (
    typeof value.projects !== "object" ||
    value.projects === null ||
    Array.isArray(value.projects)
  ) {
    throw new Error("Invalid client token file: projects must be an object");
  }
  const global =
    typeof value.global === "string"
      ? validIdentifier(value.global, "Global client token")
      : null;
  const parsedProjects = value.projects as Record<string, unknown>;
  const projects: Record<string, string> = {};
  for (const [projectDir, token] of Object.entries(parsedProjects)) {
    assertNormalizedProjectDir(projectDir);
    if (typeof token !== "string") {
      throw new Error("Invalid client token file: project tokens must be strings");
    }
    projects[projectDir] = validIdentifier(token, "Project client token");
  }
  const revision =
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
      ? value.revision
      : (() => {
          throw new Error(
            "Invalid client token file: revision must be a non-negative integer",
          );
        })();
  const globalDeleted =
    typeof value.globalDeleted === "boolean"
      ? value.globalDeleted
      : (() => {
          throw new Error(
            "Invalid client token file: globalDeleted must be a boolean",
          );
        })();
  if (global !== null && globalDeleted) {
    throw new Error(
      "Invalid client token file: globalDeleted must be false while a global token exists",
    );
  }
  const assignedTokens = [
    ...(global === null ? [] : [global]),
    ...Object.values(projects),
  ];
  if (new Set(assignedTokens).size !== assignedTokens.length) {
    throw new Error("Client token belongs to multiple scopes");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    global,
    projects: Object.freeze(projects),
    revision,
    globalDeleted,
  });
}

function isLegacyClientTokenFile(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).schemaVersion === LEGACY_SCHEMA_VERSION
    );
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function readClientTokenData(
  path: string,
): Promise<ClientTokenData | undefined> {
  try {
    return parseData(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadFileClientTokenAuthority(
  inputPath: string,
): Promise<ClientTokenAuthority> {
  const data = await readClientTokenData(resolve(inputPath));
  if (data === undefined) throw new Error("Client token file does not exist");
  const global = data.global;
  if (global === null && Object.keys(data.projects).length === 0) {
    throw new Error("Client token file must contain at least one token");
  }
  const projectByToken = new Map(
    Object.entries(data.projects).map(([projectDir, token]) => [
      token,
      projectDir,
    ]),
  );
  const ownedTokens = [
    ...(global === null ? [] : [global]),
    ...Object.values(data.projects),
  ].filter((token) => token.length > 0);
  const escape = (text: string): string =>
    text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const scrubPattern = new RegExp(
    ownedTokens.map(escape).join("|"),
    "gu",
  );
  return Object.freeze({
    authorize: (token: string) => {
      if (token === global) return Object.freeze({});
      const projectDir = projectByToken.get(token);
      return projectDir === undefined
        ? undefined
        : Object.freeze({ projectDir });
    },
    scrub: (value: string) => value.replace(scrubPattern, "[REDACTED]"),
  });
}

export function createFileClientTokenStore(
  options: FileClientTokenStoreOptions,
): FileClientTokenStore {
  const path = resolve(options.path);
  const generateToken =
    options.generateToken ?? (() => `lt_${randomBytes(32).toString("base64url")}`);
  const fileOperations = options.fileOperations ?? defaultFileOperations;

  const emptyData = (): ClientTokenData => ({
    schemaVersion: SCHEMA_VERSION,
    global: null,
    projects: {},
    revision: 0,
    globalDeleted: false,
  });
  const readData = async (): Promise<ClientTokenData | undefined> => {
    try {
      const content = await readFile(path, "utf8");
      // Client-auth v1 is disposable local access state, not a durable
      // compatibility surface. Do not migrate or reuse its token values:
      // treat it as never initialized so the current authority can generate
      // a fresh v2 file/token through the normal atomic create path.
      if (isLegacyClientTokenFile(content)) return undefined;
      return parseData(content);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  };
  /**
   * Atomic publication: write the next state to a private same-directory
   * temporary file, flush it durably, then atomically replace the target.
   * On any injected failure before publication the last valid file bytes
   * stay intact and the temporary file is cleaned safely.
   */
  const writeDataAtomic = async (data: ClientTokenData): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: AUTH_DIRECTORY_MODE });
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    let handle: FileHandle | undefined;
    try {
      handle = await fileOperations.createTemporary(temporaryPath);
      await handle.writeFile(serialized, { encoding: "utf8" });
      await fileOperations.flush(handle);
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, AUTH_FILE_MODE);
      await fileOperations.replace(temporaryPath, path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };
  const mutate = async <T>(
    expectedRevision: number | undefined,
    operation: (current: ClientTokenData) => {
      readonly result: T;
      readonly next?: ClientTokenData;
    },
  ): Promise<T> => {
    await mkdir(dirname(path), { recursive: true, mode: AUTH_DIRECTORY_MODE });
    let compromised: Error | undefined;
    // Real filesystem lock shared by every independent store instance and
    // process (offline CLI, running authority, tests): read-check-mutate-
    // write sequences serialize across writers, not just within one
    // authority's in-process queue.
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: LOCK_STALE_MS,
      retries: {
        retries: LOCK_RETRIES,
        factor: 1,
        minTimeout: LOCK_MIN_TIMEOUT_MS,
        maxTimeout: LOCK_MAX_TIMEOUT_MS,
      },
      onCompromised: (error: Error) => {
        compromised = error;
      },
    });
    try {
      if (compromised !== undefined) {
        throw new Error("Client token file lock was compromised", {
          cause: compromised,
        });
      }
      // Re-read AFTER acquiring the lock: the authoritative file is the
      // compare-and-swap generation. A mutation that read a stale revision
      // before the lock now conflicts instead of overwriting.
      const current = (await readData()) ?? emptyData();
      if (
        expectedRevision !== undefined &&
        current.revision !== expectedRevision
      ) {
        throw new ClientTokenStaleRevisionError();
      }
      const { result, next } = operation(current);
      if (next !== undefined) await writeDataAtomic(next);
      if (compromised !== undefined) {
        throw new Error("Client token file lock was compromised", {
          cause: compromised,
        });
      }
      return result;
    } finally {
      await release().catch(() => undefined);
    }
  };

  return Object.freeze({
    async create(
      scope: ClientTokenScope,
      token?: string,
      expectedRevision?: number,
    ): Promise<string> {
      const createdToken = validIdentifier(
        token ?? generateToken(),
        "Client token",
      );
      if (scope.type === "project") assertNormalizedProjectDir(scope.projectDir);
      return mutate(expectedRevision, (current) => {
        if (
          (scope.type === "global" && current.global !== null) ||
          (scope.type === "project" &&
            Object.hasOwn(current.projects, scope.projectDir))
        ) {
          throw new Error("Client token scope already has a token");
        }
        const existingTokens = new Set([
          ...(current.global === null ? [] : [current.global]),
          ...Object.values(current.projects),
        ]);
        if (existingTokens.has(createdToken)) {
          throw new Error("Client token already belongs to another scope");
        }
        return {
          result: createdToken,
          next: {
            schemaVersion: SCHEMA_VERSION,
            global: scope.type === "global" ? createdToken : current.global,
            projects: {
              ...current.projects,
              ...(scope.type === "project"
                ? { [scope.projectDir]: createdToken }
                : {}),
            },
            revision: current.revision + 1,
            globalDeleted:
              scope.type === "global" ? false : current.globalDeleted,
          },
        };
      });
    },
    async rotate(
      scope: ClientTokenScope,
      token?: string,
      expectedRevision?: number,
    ): Promise<string> {
      if (scope.type === "project") assertNormalizedProjectDir(scope.projectDir);
      const replacement = validIdentifier(
        token ?? generateToken(),
        "Client token",
      );
      return mutate(expectedRevision, (current) => {
        const currentToken =
          scope.type === "global"
            ? current.global
            : current.projects[scope.projectDir];
        if (currentToken === null || currentToken === undefined) {
          throw new Error("Client token scope does not exist");
        }
        if (replacement === currentToken) {
          throw new Error(
            "Replacement client token must be different from the current token",
          );
        }
        const otherTokens = new Set([
          ...(scope.type === "global" || current.global === null
            ? []
            : [current.global]),
          ...Object.entries(current.projects)
            .filter(
              ([projectDir]) =>
                scope.type !== "project" || projectDir !== scope.projectDir,
            )
            .map(([, projectToken]) => projectToken),
        ]);
        if (otherTokens.has(replacement)) {
          throw new Error("Client token already belongs to another scope");
        }
        return {
          result: replacement,
          next: {
            schemaVersion: SCHEMA_VERSION,
            global: scope.type === "global" ? replacement : current.global,
            projects: {
              ...current.projects,
              ...(scope.type === "project"
                ? { [scope.projectDir]: replacement }
                : {}),
            },
            revision: current.revision + 1,
            globalDeleted: current.globalDeleted,
          },
        };
      });
    },
    async remove(
      scope: ClientTokenScope,
      expectedRevision?: number,
    ): Promise<boolean> {
      if (scope.type === "project") assertNormalizedProjectDir(scope.projectDir);
      return mutate(expectedRevision, (current) => {
        if (scope.type === "global") {
          return current.global === null
            ? { result: false }
            : {
                result: true,
                next: {
                  ...current,
                  global: null,
                  globalDeleted: true,
                  revision: current.revision + 1,
                },
              };
        }
        if (!Object.hasOwn(current.projects, scope.projectDir)) {
          return { result: false };
        }
        const projects = { ...current.projects };
        delete projects[scope.projectDir];
        return {
          result: true,
          next: { ...current, projects, revision: current.revision + 1 },
        };
      });
    },
    async list(): Promise<readonly ClientTokenScope[]> {
      const data = await readData();
      if (data === undefined) return Object.freeze([]);
      const scopes: ClientTokenScope[] = [];
      if (data.global !== null) scopes.push(Object.freeze({ type: "global" }));
      for (const projectDir of Object.keys(data.projects).sort()) {
        scopes.push(Object.freeze({ type: "project", projectDir }));
      }
      return Object.freeze(scopes);
    },
    async snapshot(): Promise<ClientTokenFileSnapshot> {
      const data = await readData();
      if (data === undefined) {
        return Object.freeze({
          global: null,
          projects: Object.freeze({}),
          revision: 0,
          globalDeleted: false,
        });
      }
      return Object.freeze({
        global: data.global,
        projects: data.projects,
        revision: data.revision,
        globalDeleted: data.globalDeleted,
      });
    },
  });
}
