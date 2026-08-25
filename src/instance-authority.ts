import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface InstanceLease {
  close(): Promise<void>;
}

export interface InstanceAuthority {
  acquire(): Promise<InstanceLease>;
}

export interface InstanceAuthorityLocation {
  readonly homeDirectory: string;
}

export interface CreateInstanceAuthorityOptions {
  readonly path: string;
}

export class InstanceAuthorityOwnedError extends Error {
  readonly code = "INSTANCE_AUTHORITY_OWNED";

  constructor() {
    super("Token Backend instance is already owned");
    this.name = "InstanceAuthorityOwnedError";
  }
}

function sqliteErrorCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof (error as { readonly errcode?: unknown }).errcode === "number"
    ? (error as { readonly errcode: number }).errcode
    : undefined;
}

export function resolveBackendInstanceDatabasePath(
  location: InstanceAuthorityLocation,
): string {
  return join(location.homeDirectory, ".Token", "instance.sqlite");
}

export function createInstanceAuthority(
  options: CreateInstanceAuthorityOptions,
): InstanceAuthority {
  return Object.freeze({
    async acquire(): Promise<InstanceLease> {
      await mkdir(dirname(options.path), { recursive: true });
      const database = new DatabaseSync(options.path, { timeout: 0 });
      try {
        database.exec("BEGIN IMMEDIATE");
      } catch (error) {
        database.close();
        if (sqliteErrorCode(error) === 5) {
          throw new InstanceAuthorityOwnedError();
        }
        throw error;
      }

      let closed = false;
      return Object.freeze({
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          try {
            database.exec("ROLLBACK");
          } finally {
            database.close();
          }
        },
      });
    },
  });
}
