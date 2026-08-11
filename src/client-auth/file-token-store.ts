import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";

import type { AuthorizedClient } from "../auth.js";

const SCHEMA_VERSION = "luckytoken-client-auth-v1";
const AUTH_FILE_MODE = 0o600;
const AUTH_DIRECTORY_MODE = 0o700;

export type ClientTokenScope =
  | { readonly type: "global" }
  | { readonly type: "project"; readonly projectDir: string };

export interface ClientTokenAuthority {
  authorize(token: string): AuthorizedClient | undefined;
}

export interface FileClientTokenStore {
  create(scope: ClientTokenScope, token?: string): Promise<string>;
  rotate(scope: ClientTokenScope, token?: string): Promise<string>;
  remove(scope: ClientTokenScope): Promise<boolean>;
  list(): Promise<readonly ClientTokenScope[]>;
}

export interface FileClientTokenStoreOptions {
  readonly path: string;
  readonly generateToken?: () => string;
}

interface ClientTokenData {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly global: string | null;
  readonly projects: Readonly<Record<string, string>>;
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
  const allowed = new Set(["schemaVersion", "global", "projects"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid client token file: unknown field ${key}`);
    }
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Invalid client token file: schemaVersion must be ${SCHEMA_VERSION}`);
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
  });
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
  return Object.freeze({
    authorize: (token: string) => {
      if (token === global) return Object.freeze({});
      const projectDir = projectByToken.get(token);
      return projectDir === undefined
        ? undefined
        : Object.freeze({ projectDir });
    },
  });
}

export function createFileClientTokenStore(
  options: FileClientTokenStoreOptions,
): FileClientTokenStore {
  const path = resolve(options.path);
  const generateToken =
    options.generateToken ?? (() => `lt_${randomBytes(32).toString("base64url")}`);

  const emptyData = (): ClientTokenData => ({
    schemaVersion: SCHEMA_VERSION,
    global: null,
    projects: {},
  });
  const readData = (): Promise<ClientTokenData | undefined> =>
    readClientTokenData(path);
  const writeData = async (data: ClientTokenData): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: AUTH_DIRECTORY_MODE });
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: AUTH_FILE_MODE,
    });
    await chmod(path, AUTH_FILE_MODE);
  };
  const mutate = async <T>(
    operation: (current: ClientTokenData) => {
      readonly result: T;
      readonly next?: ClientTokenData;
    },
  ): Promise<T> => {
    const current = (await readData()) ?? emptyData();
    const { result, next } = operation(current);
    if (next !== undefined) await writeData(next);
    return result;
  };

  return Object.freeze({
    async create(scope: ClientTokenScope, token?: string): Promise<string> {
      const createdToken = validIdentifier(
        token ?? generateToken(),
        "Client token",
      );
      if (scope.type === "project") assertNormalizedProjectDir(scope.projectDir);
      return mutate((current) => {
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
          },
        };
      });
    },
    async rotate(scope: ClientTokenScope, token?: string): Promise<string> {
      if (scope.type === "project") assertNormalizedProjectDir(scope.projectDir);
      const replacement = validIdentifier(
        token ?? generateToken(),
        "Client token",
      );
      return mutate((current) => {
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
          },
        };
      });
    },
    async remove(scope: ClientTokenScope): Promise<boolean> {
      if (scope.type === "project") assertNormalizedProjectDir(scope.projectDir);
      return mutate((current) => {
        if (scope.type === "global") {
          return current.global === null
            ? { result: false }
            : { result: true, next: { ...current, global: null } };
        }
        if (!Object.hasOwn(current.projects, scope.projectDir)) {
          return { result: false };
        }
        const projects = { ...current.projects };
        delete projects[scope.projectDir];
        return { result: true, next: { ...current, projects } };
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
  });
}
