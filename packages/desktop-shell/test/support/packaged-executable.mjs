import { access, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export async function resolvePackagedExecutable(
  desktopRoot,
  environment = process.env,
) {
  const selected = environment.TOKEN_PACKAGED_EXECUTABLE?.trim();
  if (selected) {
    if (!isAbsolute(selected)) {
      throw new Error("selected packaged Token executable must be an absolute path");
    }
    const executable = resolve(selected);
    try {
      await access(executable);
    } catch {
      throw new Error(
        `selected packaged Token executable does not exist: ${executable}`,
      );
    }
    return executable;
  }

  const outputRoot = join(desktopRoot, ".electron-out");
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const executable = join(
      outputRoot,
      entry.name,
      "token-win32-x64",
      "Token.exe",
    );
    try {
      const metadata = await stat(executable);
      candidates.push({ executable, mtimeMs: metadata.mtimeMs });
    } catch {
      // Direct local E2E runs may coexist with partial/other-platform outputs.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = candidates[0];
  if (latest === undefined) throw new Error("no packaged Token executable found");
  return latest.executable;
}
