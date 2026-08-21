import { access, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export async function resolvePackagedExecutable(
  desktopRoot,
  environment = process.env,
) {
  const selected = environment.LUCKYTOKEN_PACKAGED_EXECUTABLE?.trim();
  if (selected) {
    if (!isAbsolute(selected)) {
      throw new Error("selected packaged LuckyToken executable must be an absolute path");
    }
    const executable = resolve(selected);
    try {
      await access(executable);
    } catch {
      throw new Error(
        `selected packaged LuckyToken executable does not exist: ${executable}`,
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
      "LuckyToken-win32-x64",
      "LuckyToken.exe",
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
  if (latest === undefined) throw new Error("no packaged LuckyToken executable found");
  return latest.executable;
}
