import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import type {
  EffectiveCatalogProjection,
  ModelsCommandResult,
  ModelsFileError,
  ModelsFileState,
  ModelsProjection,
} from "@token/application-control-plane/control-plane";
import lockfile from "proper-lockfile";

import {
  stripJsonComments,
  validateModelsJsonValue,
} from "../providers/models-json-schema.js";

/**
 * Authoritative Token-owned models.json store (Ticket 08).
 *
 * The file at `path` is the single authority. Every command re-reads the
 * file, so external edits become visible immediately; every successful write
 * validates first, takes the file lock, re-checks the on-disk bytes against
 * the revision the client was served, and replaces the file atomically via a
 * temporary file and rename. Failed or stale writes never modify the file.
 *
 * Revisions: a monotonically increasing integer that changes whenever the
 * on-disk content changes — through this authority or externally. Writes are
 * compare-and-swap on the revision the client last received; a stale
 * revision returns an explicit `conflict` and never loses updates.
 *
 * Error reporting is value-free (paths and locations only), so it stays
 * within Ticket 07's credential boundary: parse errors report the exact
 * line/column (within the comment-stripped view used by the pinned Pi
 * parser), schema errors report actionable dotted paths, and raw file
 * content or secret values are never echoed.
 */

export interface ModelsJsonFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
}

/** Test seam at the file-system boundary; the default is the node fs. */
const nodeFileSystem: ModelsJsonFileSystem = Object.freeze({
  readFile: (path: string) => readFile(path, "utf8"),
  writeFile: (path: string, content: string) =>
    writeFile(path, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    }),
  rename,
  mkdir: async (path: string) => {
    await mkdir(path, { recursive: true });
  },
  rm: (path: string) => rm(path, { force: true }),
});

export interface ModelsJsonLock {
  acquire(path: string): Promise<() => Promise<void>>;
}

const lockStaleMs = 30_000;

function createNodeLock(): ModelsJsonLock {
  return Object.freeze({
    async acquire(path: string): Promise<() => Promise<void>> {
      let compromised: Error | undefined;
      try {
        const release = await lockfile.lock(path, {
          realpath: false,
          retries: { retries: 20, minTimeout: 20, maxTimeout: 250 },
          stale: lockStaleMs,
          onCompromised: (error) => {
            compromised = error;
          },
        });
        if (compromised !== undefined) {
          await release().catch(() => undefined);
          throw new Error("models.json lock ownership was compromised");
        }
        return release;
      } catch (error) {
        if (compromised !== undefined) throw compromised;
        throw error;
      }
    },
  });
}

export interface ModelsJsonAuthorityOptions {
  readonly path: string;
  readonly fileSystem?: ModelsJsonFileSystem;
  readonly lock?: ModelsJsonLock;
  /**
   * Effective catalog composition (Ticket 09): computes the public
   * built-in + user catalog projection from a parsed valid providers
   * record. The authority is the single owner of the file facts; the
   * composer is the single owner of the pinned Pi semantics, and the
   * resulting projection rides on every valid authoritative state.
   */
  readonly compose: (
    providers: Readonly<Record<string, unknown>>,
  ) => EffectiveCatalogProjection;
}

export interface ModelsJsonAuthority {
  /** Current authoritative state; refreshes from disk first. */
  query(): Promise<ModelsFileState>;
  /** Compare-and-swap raw write: validates, locks, atomically replaces. */
  writeRaw(input: {
    readonly revision: number;
    readonly content: string;
  }): Promise<ModelsCommandResult>;
  /** Compare-and-swap structured write over the parsed providers record. */
  writeStructured(input: {
    readonly revision: number;
    readonly providers: Readonly<Record<string, unknown>>;
  }): Promise<ModelsCommandResult>;
  /** Sanitized projection for status snapshots (never refreshes). */
  snapshot(): ModelsProjection;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function lineColumnAt(
  text: string,
  position: number,
): { readonly line: number; readonly column: number } {
  let line = 1;
  let lineStart = 0;
  const limit = Math.min(position, text.length);
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}

/**
 * Finds the first JSON syntax error in plain (comment-stripped) text with an
 * exact character position. Runs only when `JSON.parse` already failed, so
 * it never decides acceptance; it only supplies the exact source location
 * and a value-free description that V8's `Unexpected token` messages omit.
 */
function firstJsonSyntaxError(
  text: string,
): { readonly position: number; readonly description: string } | undefined {
  const length = text.length;
  let index = 0;

  const skipWhitespace = (): void => {
    while (
      index < length &&
      (text[index] === " " ||
        text[index] === "\t" ||
        text[index] === "\n" ||
        text[index] === "\r")
    ) {
      index += 1;
    }
  };
  const fail = (position: number, description: string) => ({ position, description });

  const parseString = (): ReturnType<typeof fail> | undefined => {
    const start = index;
    index += 1; // opening quote
    for (;;) {
      if (index >= length) return fail(start, "Unterminated string");
      const char = text[index] as string;
      if (char === "\"") {
        index += 1;
        return undefined;
      }
      if (char === "\\") {
        const escape = text[index + 1];
        if (
          escape === '"' ||
          escape === "\\" ||
          escape === "/" ||
          escape === "b" ||
          escape === "f" ||
          escape === "n" ||
          escape === "r" ||
          escape === "t"
        ) {
          index += 2;
          continue;
        }
        if (escape === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
            index += 6;
            continue;
          }
          return fail(index, "Invalid \\u escape");
        }
        return fail(index, "Invalid escape sequence");
      }
      if (char.charCodeAt(0) < 0x20) {
        return fail(index, "Bad control character in string");
      }
      index += 1;
    }
  };

  const parseNumber = (): ReturnType<typeof fail> | undefined => {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
      if (/[0-9]/u.test(text[index] ?? "")) {
        return fail(index, "Unexpected digit after leading zero");
      }
    } else if (/[1-9]/u.test(text[index] ?? "")) {
      index += 1;
      while (/[0-9]/u.test(text[index] ?? "")) index += 1;
    } else {
      return fail(index, "Invalid number");
    }
    if (text[index] === ".") {
      index += 1;
      if (!/[0-9]/u.test(text[index] ?? "")) {
        return fail(index, "Expected digit after decimal point");
      }
      while (/[0-9]/u.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!/[0-9]/u.test(text[index] ?? "")) {
        return fail(index, "Expected digit in exponent");
      }
      while (/[0-9]/u.test(text[index] ?? "")) index += 1;
    }
    if (start === index) return fail(index, "Invalid number");
    return undefined;
  };

  const parseLiteral = (expected: string): ReturnType<typeof fail> | undefined => {
    const start = index;
    if (text.slice(index, index + expected.length) === expected) {
      index += expected.length;
      return undefined;
    }
    return fail(start, `Expected '${expected}'`);
  };

  const parseValue = (): ReturnType<typeof fail> | undefined => {
    skipWhitespace();
    if (index >= length) return fail(length, "Unexpected end of JSON input");
    const char = text[index] as string;
    if (char === "{") return parseObject();
    if (char === "[") return parseArray();
    if (char === '"') return parseString();
    if (char === "t") return parseLiteral("true");
    if (char === "f") return parseLiteral("false");
    if (char === "n") return parseLiteral("null");
    if (char === "-" || (char >= "0" && char <= "9")) return parseNumber();
    return fail(index, `Unexpected character '${char}'`);
  };

  const parseObject = (): ReturnType<typeof fail> | undefined => {
    index += 1; // {
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return undefined;
    }
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') {
        return fail(index, "Expected a property name");
      }
      const property = parseString();
      if (property !== undefined) return property;
      skipWhitespace();
      if (text[index] !== ":") {
        return fail(index, "Expected ':' after property name");
      }
      index += 1;
      const value = parseValue();
      if (value !== undefined) return value;
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return undefined;
      }
      return fail(index, "Expected ',' or '}'");
    }
  };

  const parseArray = (): ReturnType<typeof fail> | undefined => {
    index += 1; // [
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return undefined;
    }
    for (;;) {
      const value = parseValue();
      if (value !== undefined) return value;
      skipWhitespace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return undefined;
      }
      return fail(index, "Expected ',' or ']'");
    }
  };

  const error = parseValue();
  if (error !== undefined) return error;
  skipWhitespace();
  if (index < length) return fail(index, "Unexpected content after value");
  return undefined;
}

/** Parse with the pinned Pi-compatible syntax (comments + trailing commas
 *  allowed) and turn syntax failures into value-free errors with the exact
 *  source location within the parsed (comment-stripped) view. */
function parseConfigText(text: string):
  | { readonly parsed: unknown }
  | { readonly error: ModelsFileError } {
  const stripped = stripJsonComments(text);
  try {
    return { parsed: JSON.parse(stripped) };
  } catch {
    const scanned = firstJsonSyntaxError(stripped);
    const position = scanned?.position;
    const location =
      position === undefined
        ? undefined
        : { ...lineColumnAt(stripped, position), position };
    const base = scanned?.description ?? "Invalid JSON";
    return {
      error: {
        kind: "parse",
        message:
          location === undefined
            ? base
            : `${base} at position ${position} (line ${location.line}, column ${location.column})`,
        ...(location === undefined ? {} : { location }),
      },
    };
  }
}

function schemaErrorFromValidation(
  validation: Extract<
    ReturnType<typeof validateModelsJsonValue>,
    { readonly valid: false }
  >,
): ModelsFileError {
  return {
    kind: "schema",
    message: `Invalid models.json schema:\n${validation.errors
      .map((error) => `  - ${error.path}: ${error.message}`)
      .join("\n")}`,
  };
}

function schemaError(
  parsed: unknown,
): ModelsFileError {
  const validation = validateModelsJsonValue(parsed);
  if (validation.valid) {
    throw new Error("internal: expected invalid models.json value");
  }
  return schemaErrorFromValidation(validation);
}

/** Build the authoritative state for the given on-disk facts. */
function buildState(
  path: string,
  revision: number,
  raw: string,
  present: boolean,
  readError: unknown | undefined,
  compose: (
    providers: Readonly<Record<string, unknown>>,
  ) => EffectiveCatalogProjection,
): ModelsFileState {
  if (!present) {
    return Object.freeze({
      revision,
      path,
      present: false,
      valid: false,
      raw: "",
    });
  }
  if (readError !== undefined) {
    return Object.freeze({
      revision,
      path,
      present: true,
      valid: false,
      raw,
      error: {
        kind: "load" as const,
        message: `Failed to read models.json: ${
          readError instanceof Error ? readError.message : String(readError)
        }`,
      },
    });
  }
  const parsedResult = parseConfigText(raw);
  if ("error" in parsedResult) {
    return Object.freeze({
      revision,
      path,
      present: true,
      valid: false,
      raw,
      error: parsedResult.error,
    });
  }
  const validation = validateModelsJsonValue(parsedResult.parsed);
  if (!validation.valid) {
    return Object.freeze({
      revision,
      path,
      present: true,
      valid: false,
      raw,
      error: schemaError(parsedResult.parsed),
    });
  }
  const providers = (parsedResult.parsed as { readonly providers: Record<string, unknown> })
    .providers;
  // The effective catalog (Ticket 09) is part of every valid authoritative
  // state; the composer never leaks credentials or auth state into it.
  const catalog = compose(providers);
  return Object.freeze({
    revision,
    path,
    present: true,
    valid: true,
    raw,
    providers: Object.freeze(providers),
    catalog,
  });
}

export function createModelsJsonAuthority(
  options: ModelsJsonAuthorityOptions,
): ModelsJsonAuthority {
  const path = options.path;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const lock = options.lock ?? createNodeLock();
  const compose = options.compose;
  let current: ModelsFileState = Object.freeze({
    revision: 0,
    path,
    present: false,
    valid: false,
    raw: "",
  });
  // On-disk facts the served state was derived from; used to detect external
  // edits that should bump the revision.
  let diskRaw = "";
  let diskPresent = false;
  let refreshed = false;

  const refresh = async (): Promise<ModelsFileState> => {
    let raw: string;
    let present = true;
    let readError: unknown;
    try {
      raw = await fileSystem.readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        present = false;
        raw = "";
      } else {
        raw = "";
        readError = error;
      }
    }
    if (refreshed && present === diskPresent && raw === diskRaw) {
      return current;
    }
    const firstObservation = !refreshed;
    refreshed = true;
    diskPresent = present;
    diskRaw = raw;
    const next = buildState(path, current.revision, raw, present, readError, compose);
    if (firstObservation) {
      // The first observation is the baseline: the existing file's content
      // is revision 0, never a bump over the fictional empty state.
      current = next;
    } else if (next.present !== current.present || next.raw !== current.raw) {
      current = Object.freeze({ ...next, revision: current.revision + 1 });
    } else {
      current = next;
    }
    return current;
  };

  const commit = async (
    base: ModelsFileState,
    nextRaw: string,
    providers: Readonly<Record<string, unknown>>,
  ): Promise<ModelsCommandResult> => {
    try {
      await fileSystem.mkdir(dirname(path));
    } catch (error) {
      return Object.freeze({
        outcome: "storage_failure",
        state: current,
        error: {
          kind: "storage" as const,
          message: `Failed to create the models.json directory: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lock.acquire(path);
    } catch (error) {
      return Object.freeze({
        outcome: "storage_failure",
        state: current,
        error: {
          kind: "storage" as const,
          message: `Failed to lock models.json: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      // The disk must still hold exactly what the client was served for its
      // revision; an external edit racing the write is a conflict, never an
      // overwrite.
      let diskContent: string;
      let present = true;
      try {
        diskContent = await fileSystem.readFile(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          present = false;
          diskContent = "";
        } else {
          throw error;
        }
      }
      if (present !== base.present || diskContent !== base.raw) {
        await refresh();
        return Object.freeze({
          outcome: "conflict",
          state: current,
        });
      }
      await fileSystem.writeFile(temporaryPath, nextRaw);
      await fileSystem.rename(temporaryPath, path);
    } catch (error) {
      await fileSystem.rm(temporaryPath).catch(() => undefined);
      return Object.freeze({
        outcome: "storage_failure",
        state: current,
        error: {
          kind: "storage" as const,
          message: `Failed to write models.json: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } finally {
      await release().catch(() => undefined);
    }
    diskRaw = nextRaw;
    diskPresent = true;
    const next = Object.freeze({
      // Monotonic even when an external edit/revert raced the write.
      revision: Math.max(current.revision, base.revision) + 1,
      path,
      present: true,
      valid: true,
      raw: nextRaw,
      providers,
      catalog: compose(providers),
    });
    current = next;
    return Object.freeze({ outcome: "ok", state: next });
  };

  const authority: ModelsJsonAuthority = {
    async query(): Promise<ModelsFileState> {
      return refresh();
    },
    async writeRaw(input): Promise<ModelsCommandResult> {
      await refresh();
      if (input.revision !== current.revision) {
        return Object.freeze({ outcome: "conflict", state: current });
      }
      const parsedResult = parseConfigText(input.content);
      if ("error" in parsedResult) {
        return Object.freeze({
          outcome: "invalid",
          state: current,
          error: parsedResult.error,
        });
      }
      const validation = validateModelsJsonValue(parsedResult.parsed);
      if (!validation.valid) {
        return Object.freeze({
          outcome: "invalid",
          state: current,
          error: schemaErrorFromValidation(validation),
        });
      }
      if (current.present && input.content === current.raw) {
        // Byte-identical write: no file change, no revision bump.
        return Object.freeze({ outcome: "ok", state: current });
      }
      const providers = (parsedResult.parsed as { readonly providers: Record<string, unknown> })
        .providers;
      return commit(
        current,
        input.content,
        Object.freeze(providers),
      );
    },
    async writeStructured(input): Promise<ModelsCommandResult> {
      await refresh();
      if (input.revision !== current.revision) {
        return Object.freeze({ outcome: "conflict", state: current });
      }
      const validation = validateModelsJsonValue({
        providers: input.providers,
      });
      if (!validation.valid) {
        return Object.freeze({
          outcome: "invalid",
          state: current,
          error: schemaErrorFromValidation(validation),
        });
      }
      const serialized = `${JSON.stringify(
        { providers: input.providers },
        null,
        2,
      )}\n`;
      if (current.present && serialized === current.raw) {
        return Object.freeze({ outcome: "ok", state: current });
      }
      return commit(current, serialized, Object.freeze({ ...input.providers }));
    },
    snapshot(): ModelsProjection {
      const { revision, path: filePath, present, valid, error } = current;
      return Object.freeze({
        revision,
        path: filePath,
        present,
        valid,
        ...(error === undefined ? {} : { error }),
      });
    },
  };
  return Object.freeze(authority);
}
