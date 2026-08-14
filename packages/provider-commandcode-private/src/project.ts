import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const STRUCTURE_EXCLUSIONS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".svn",
  ".hg",
  "coverage",
  ".nyc_output",
  ".cache",
  "tmp",
  "temp",
  ".next",
  ".nuxt",
  "out",
]);

export interface ServerConfig {
  workingDir: string;
  date: string;
  environment: string;
  structure: string[];
  isGitRepo: boolean;
  currentBranch: string;
  mainBranch: string;
  gitStatus: string;
  recentCommits: string[];
}

export type GitOutput = { ok: true; output: string } | { ok: false };

export interface ProjectSnapshot {
  snapshot(input: {
    projectDir: string;
    signal: AbortSignal;
  }): Promise<ServerConfig>;
}

export interface ProjectSnapshotDependencies {
  readDirectory(projectDir: string): Promise<readonly string[]>;
  runGit(
    projectDir: string,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<GitOutput>;
  utcDate(): string;
  platform: string;
  homeDir: string;
  workspaceRoots(projectDir: string): readonly string[];
}

export function classifyProjectDir(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const projectDir = metadata?.projectDir;
  return typeof projectDir === "string" && projectDir.length > 0
    ? projectDir
    : undefined;
}

export function createEmptyServerConfig(): ServerConfig {
  return {
    workingDir: "",
    date: "",
    environment: "",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

function formatScopeDir(dir: string, projectDir: string, homeDir: string): string {
  if (dir === projectDir) return ".";
  if (dir.startsWith(`${projectDir}/`)) return `./${dir.slice(projectDir.length + 1)}`;
  if (dir === homeDir) return "~";
  if (dir.startsWith(`${homeDir}/`)) return `~/${dir.slice(homeDir.length + 1)}`;
  return dir;
}

export function createProjectSnapshot(
  dependencies: ProjectSnapshotDependencies,
): ProjectSnapshot {
  return {
    async snapshot({ projectDir, signal }): Promise<ServerConfig> {
      signal.throwIfAborted();
      const scopes = dependencies
        .workspaceRoots(projectDir)
        .filter((root) => root !== projectDir)
        .map(
          (root) =>
            `scope:${formatScopeDir(
              root,
              projectDir,
              dependencies.homeDir,
            )}`,
        );

      let structure: string[];
      try {
        const entries = await dependencies.readDirectory(projectDir);
        signal.throwIfAborted();
        structure = [
          ...entries
            .filter(
              (name) =>
                !name.startsWith(".") && !STRUCTURE_EXCLUSIONS.has(name),
            )
            .sort(),
          ...scopes,
        ];
      } catch (error) {
        signal.throwIfAborted();
        void error;
        structure = scopes;
      }

      const runGit = async (args: readonly string[]): Promise<GitOutput> => {
        signal.throwIfAborted();
        const result = await dependencies.runGit(projectDir, args, signal);
        signal.throwIfAborted();
        return result;
      };

      const common = {
        workingDir: projectDir,
        date: dependencies.utcDate(),
        environment: dependencies.platform,
        structure,
      };
      const gitDirectory = await runGit(["rev-parse", "--git-dir"]);
      if (!gitDirectory.ok) {
        return {
          ...common,
          isGitRepo: false,
          currentBranch: "",
          mainBranch: "",
          gitStatus: "",
          recentCommits: [],
        };
      }

      const currentBranch = await runGit(["branch", "--show-current"]);
      const remoteHead = await runGit([
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      let mainBranch: string;
      if (remoteHead.ok && remoteHead.output.length > 0) {
        mainBranch = remoteHead.output.replace(/^origin\//u, "");
      } else {
        const remoteBranches = await runGit(["branch", "-r"]);
        if (!remoteBranches.ok) mainBranch = "";
        else if (remoteBranches.output.includes("origin/main")) mainBranch = "main";
        else if (remoteBranches.output.includes("origin/master")) mainBranch = "master";
        else mainBranch = "main";
      }
      const status = await runGit(["status", "--porcelain"]);
      const recentCommits = await runGit(["log", "--oneline", "-3"]);

      return {
        ...common,
        isGitRepo: true,
        currentBranch: currentBranch.ok ? currentBranch.output : "",
        mainBranch,
        gitStatus: status.ok ? status.output || "Working tree clean" : "",
        recentCommits:
          recentCommits.ok && recentCommits.output.length > 0
            ? recentCommits.output.split("\n")
            : [],
      };
    },
  };
}

export function createNodeProjectSnapshot(): ProjectSnapshot {
  return createProjectSnapshot({
    readDirectory: (projectDir) => readdir(projectDir),
    runGit: async (projectDir, args, signal) => {
      try {
        const { stdout } = await execFileAsync("git", [...args], {
          cwd: projectDir,
          encoding: "utf8",
          windowsHide: true,
          signal,
        });
        return { ok: true, output: String(stdout).trim() };
      } catch (error) {
        signal.throwIfAborted();
        void error;
        return { ok: false };
      }
    },
    utcDate: () => new Date().toISOString().slice(0, 10),
    platform: process.platform,
    homeDir: os.homedir(),
    workspaceRoots: (projectDir) => [projectDir],
  });
}
