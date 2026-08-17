/** Store-owned, consistent SQLite backup snapshot for Ticket 24. */
import { randomBytes } from "node:crypto";
import { chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { backup, type DatabaseSync } from "node:sqlite";

export async function createSqliteBackupSnapshot(
  database: DatabaseSync,
  directory: string,
  prefix: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const path = join(
    directory,
    `.${prefix}.backup.${process.pid}.${randomBytes(8).toString("hex")}.sqlite3`,
  );
  try {
    // node:sqlite owns the online-backup lifecycle and produces one
    // self-contained snapshot; copying the live db/-wal pair here would not
    // provide a consistent point-in-time artifact.
    await backup(database, path);
    await chmod(path, 0o600).catch(() => undefined);
    signal.throwIfAborted();
    return await readFile(path);
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}
