import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export type CodexFileUpdateResult = "unchanged" | "written" | "conflict";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function replaceTextFileIfUnchanged(
  path: string,
  expected: string,
  content: string,
): Promise<CodexFileUpdateResult> {
  if (content === expected) return "unchanged";

  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if ((await readOptional(path)) !== expected) return "conflict";
    await rename(temporary, path);
    return "written";
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
