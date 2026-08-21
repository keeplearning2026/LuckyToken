import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");
const desktopRoot = join(repositoryRoot, "packages", "desktop-shell");
const electronOutputRoot = join(desktopRoot, ".electron-out");

async function requireFile(path, label) {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  return path;
}

export async function discoverWindowsCandidate(outputRoot, version) {
  const resolvedOutputRoot = resolve(outputRoot);
  const packageRoot = join(resolvedOutputRoot, "LuckyToken-win32-x64");
  const packagedExecutable = await requireFile(
    join(packageRoot, "LuckyToken.exe"),
    "packaged LuckyToken executable",
  );
  const backendBuildIdPath = await requireFile(
    join(packageRoot, "resources", "backend", "build-id.txt"),
    "packaged Backend build identity",
  );
  const makeRoot = join(resolvedOutputRoot, "make", "squirrel.windows", "x64");
  const makerEntries = await readdir(makeRoot, { withFileTypes: true });
  const installers = makerEntries
    .filter(
      (entry) =>
        entry.isFile() && /setup\.exe$/iu.test(entry.name),
    )
    .map((entry) => join(makeRoot, entry.name));
  if (installers.length !== 1) {
    throw new Error(
      `expected exactly one Squirrel Setup.exe, found ${installers.length}`,
    );
  }
  const nupkgs = makerEntries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.endsWith(`-${version}-full.nupkg`),
    )
    .map((entry) => join(makeRoot, entry.name));
  if (nupkgs.length !== 1) {
    throw new Error(
      `expected exactly one Squirrel full nupkg for ${version}, found ${nupkgs.length}`,
    );
  }
  const releases = await requireFile(
    join(makeRoot, "RELEASES"),
    "Squirrel RELEASES metadata",
  );
  return {
    outputRoot: resolvedOutputRoot,
    packageRoot,
    packagedExecutable,
    backendBuildIdPath,
    installer: installers[0],
    nupkg: nupkgs[0],
    releases,
  };
}

async function run(file, arguments_, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(file, arguments_, {
      cwd: repositoryRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `${options.label ?? basename(file)} failed (${signal ?? `exit ${String(code)}`})`,
        ),
      );
    });
  });
}

async function capture(file, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, arguments_, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      reject(
        new Error(
          `${basename(file)} failed (${signal ?? `exit ${String(code)}`}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
}

function npmCommand(arguments_, options) {
  if (process.platform !== "win32") {
    return run("npm", arguments_, options);
  }
  return run(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", "npm.cmd", ...arguments_],
    options,
  );
}

async function outputDirectories() {
  try {
    return new Set(
      (await readdir(electronOutputRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

async function makeCandidate() {
  const before = await outputDirectories();
  await npmCommand(["run", "build:packages"], { label: "package build" });
  await npmCommand(["run", "release:assemble-backend"], {
    label: "release Backend assembly",
  });
  await npmCommand(
    ["run", "make:prepared", "--workspace", "@luckytoken/desktop-shell"],
    { label: "Squirrel make" },
  );
  const after = await outputDirectories();
  const added = [...after].filter((entry) => !before.has(entry));
  if (added.length !== 1) {
    throw new Error(
      `one make invocation must create exactly one output directory; found ${added.length}`,
    );
  }
  return join(electronOutputRoot, added[0]);
}

async function sha256(path) {
  const hash = createHash("sha256");
  const file = await readFile(path);
  hash.update(file);
  return hash.digest("hex");
}

async function artifact(path) {
  const metadata = await stat(path);
  return {
    fileName: basename(path),
    bytes: metadata.size,
    sha256: await sha256(path),
  };
}

function parseArguments(arguments_) {
  let official = false;
  let reuseOutput;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--official") {
      official = true;
      continue;
    }
    if (argument === "--reuse-output") {
      const value = arguments_[index + 1];
      if (value === undefined) throw new Error("--reuse-output requires a path");
      reuseOutput = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown release candidate option: ${argument}`);
  }
  if (official && reuseOutput !== undefined) {
    throw new Error("official releases must build a new candidate; reuse is forbidden");
  }
  return { official, reuseOutput };
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("LuckyToken Windows release candidates must be built on Windows");
  }
  const options = parseArguments(process.argv.slice(2));
  const rootManifest = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const version = rootManifest.version;
  const commit = await capture("git", ["rev-parse", "HEAD"]);
  const initialStatus = await capture("git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  const dirty = initialStatus.length > 0;
  const certificateFile = process.env.LUCKYTOKEN_WINDOWS_CERTIFICATE_FILE;
  const certificatePassword = process.env.LUCKYTOKEN_WINDOWS_CERTIFICATE_PASSWORD;
  const signingConfigured =
    certificateFile !== undefined && certificatePassword !== undefined;
  if ((certificateFile === undefined) !== (certificatePassword === undefined)) {
    throw new Error(
      "Windows signing requires both LUCKYTOKEN_WINDOWS_CERTIFICATE_FILE and LUCKYTOKEN_WINDOWS_CERTIFICATE_PASSWORD",
    );
  }
  if (options.official && dirty) {
    throw new Error("official release requires a clean Git worktree");
  }
  if (options.official && !signingConfigured) {
    throw new Error("official release requires an Authenticode signing certificate");
  }

  const startedAt = new Date().toISOString();
  if (options.reuseOutput === undefined) {
    await npmCommand(["run", "typecheck"], { label: "typecheck" });
    await npmCommand(["run", "lint"], { label: "lint" });
    await npmCommand(["audit", "--omit=dev", "--audit-level=high"], {
      label: "production dependency audit",
    });
    await npmCommand(["run", "test:release"], { label: "release source test" });
  }

  const outputRoot = options.reuseOutput ?? (await makeCandidate());
  const candidate = await discoverWindowsCandidate(outputRoot, version);
  const backendBuildId = (
    await readFile(candidate.backendBuildIdPath, "utf8")
  ).trim();
  if (!/^[a-f0-9]{64}$/u.test(backendBuildId)) {
    throw new Error("packaged Backend build identity is invalid");
  }

  const selectedEnvironment = {
    ...process.env,
    LUCKYTOKEN_PACKAGED_EXECUTABLE: candidate.packagedExecutable,
  };
  await npmCommand(["run", "release:verify-layout"], {
    label: "release layout certification",
    env: selectedEnvironment,
  });
  await run(
    process.execPath,
    ["--test", "test/distribution/*.test.mjs"],
    { label: "distribution package certification", env: selectedEnvironment },
  );
  await npmCommand(
    ["run", "test:product-e2e:run", "--workspace", "@luckytoken/desktop-shell"],
    { label: "packaged product certification", env: selectedEnvironment },
  );

  const machineCertification =
    options.official || process.env.LUCKYTOKEN_RELEASE_MACHINE_CERTIFY === "1";
  if (machineCertification) {
    const powershell = process.env.PWSH_EXE ?? "pwsh.exe";
    await run(
      powershell,
      [
        "-NoProfile",
        "-File",
        join(repositoryRoot, "scripts", "windows-release-certification.ps1"),
        "-InstallerPath",
        candidate.installer,
        "-Version",
        version,
        ...(options.official ? ["-RequireSignature"] : []),
      ],
      { label: "installed product certification" },
    );
  }

  const finalStatus = await capture("git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (options.official && finalStatus.length > 0) {
    throw new Error("official release changed the Git worktree during certification");
  }

  const channel = options.official ? "releases" : "release-candidates";
  const destination = join(
    repositoryRoot,
    "artifacts",
    channel,
    `${version}-${commit.slice(0, 12)}`,
  );
  await mkdir(destination, { recursive: true });
  const published = {};
  for (const [key, source] of Object.entries({
    installer: candidate.installer,
    nupkg: candidate.nupkg,
    releases: candidate.releases,
  })) {
    const destinationPath = join(destination, basename(source));
    await copyFile(source, destinationPath);
    published[key] = await artifact(destinationPath);
  }

  const manifest = {
    schemaVersion: "luckytoken-release-candidate-v1",
    version,
    platform: "win32",
    arch: "x64",
    source: {
      commit,
      dirty,
      buildMode: options.reuseOutput === undefined ? "built-once" : "reused-local-output",
    },
    backendBuildId,
    signing: {
      configured: signingConfigured,
      required: options.official,
    },
    certification: {
      sourceGates: options.reuseOutput === undefined,
      packagedProduct: true,
      blankFirstRunProviderCatalog: true,
      installedProduct: machineCertification,
      finishedAt: new Date().toISOString(),
    },
    promotable:
      options.official && !dirty && signingConfigured && finalStatus.length === 0,
    artifacts: published,
    provenance: {
      forgeOutput: relative(repositoryRoot, candidate.outputRoot).replaceAll("\\", "/"),
      packagedExecutableSha256: await sha256(candidate.packagedExecutable),
      startedAt,
    },
  };
  const manifestPath = join(destination, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`\nRelease candidate: ${destination}\n`);
  process.stdout.write(`Installer SHA256: ${published.installer.sha256}\n`);
  process.stdout.write(`Promotable: ${manifest.promotable}\n`);
}

const entryPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
