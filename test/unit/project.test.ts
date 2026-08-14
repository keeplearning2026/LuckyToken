import { describe, expect, it } from "vitest";

import {
  classifyProjectDir,
  createEmptyServerConfig,
  createProjectSnapshot,
  type GitOutput,
} from "../../packages/provider-commandcode-private/src/project.js";

describe("CommandCode project identity and snapshot", () => {
  it("classifies only non-empty strings as project-bound", () => {
    expect(classifyProjectDir(undefined)).toBeUndefined();
    expect(classifyProjectDir({})).toBeUndefined();
    expect(classifyProjectDir({ projectDir: "" })).toBeUndefined();
    expect(classifyProjectDir({ projectDir: 42 })).toBeUndefined();
    expect(classifyProjectDir({ projectDir: "/workspace" })).toBe("/workspace");
    expect(createEmptyServerConfig()).toEqual({
      workingDir: "",
      date: "",
      environment: "",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    });
  });

  it("builds the project snapshot with fixed filtering and Git command order", async () => {
    const commands: string[][] = [];
    const outputs = new Map<string, GitOutput>([
      ["rev-parse --git-dir", { ok: true, output: ".git" }],
      ["branch --show-current", { ok: true, output: "" }],
      ["symbolic-ref --short refs/remotes/origin/HEAD", { ok: false }],
      ["branch -r", { ok: true, output: "origin/master" }],
      ["status --porcelain", { ok: true, output: "" }],
      ["log --oneline -3", { ok: true, output: "abc123 first\ndef456 second" }],
    ]);
    const snapshot = createProjectSnapshot({
      readDirectory: async () => ["zeta", "node_modules", ".secret", "alpha", "dist"],
      runGit: async (_cwd, args) => {
        commands.push([...args]);
        return outputs.get(args.join(" ")) ?? { ok: false };
      },
      utcDate: () => "2026-08-10",
      platform: "win32",
      homeDir: "/home/user",
      workspaceRoots: () => ["/workspace", "/workspace/other", "/outside"],
    });

    await expect(
      snapshot.snapshot({
        projectDir: "/workspace",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      workingDir: "/workspace",
      date: "2026-08-10",
      environment: "win32",
      structure: ["alpha", "zeta", "scope:./other", "scope:/outside"],
      isGitRepo: true,
      currentBranch: "",
      mainBranch: "master",
      gitStatus: "Working tree clean",
      recentCommits: ["abc123 first", "def456 second"],
    });
    expect(commands).toEqual([
      ["rev-parse", "--git-dir"],
      ["branch", "--show-current"],
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      ["branch", "-r"],
      ["status", "--porcelain"],
      ["log", "--oneline", "-3"],
    ]);
  });

  it("keeps an unreadable non-Git path project-bound and preserves scope fallbacks", async () => {
    const commands: string[][] = [];
    const snapshot = createProjectSnapshot({
      readDirectory: async () => {
        throw new Error("unreadable");
      },
      runGit: async (_cwd, args) => {
        commands.push([...args]);
        return { ok: false };
      },
      utcDate: () => "2026-08-10",
      platform: "linux",
      homeDir: "/home/user",
      workspaceRoots: () => ["/missing", "/home/user/shared"],
    });

    await expect(
      snapshot.snapshot({
        projectDir: "/missing",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      workingDir: "/missing",
      date: "2026-08-10",
      environment: "linux",
      structure: ["scope:~/shared"],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    });
    expect(commands).toEqual([["rev-parse", "--git-dir"]]);
  });

  it("discards snapshot work when cancellation arrives during inspection", async () => {
    const controller = new AbortController();
    const snapshot = createProjectSnapshot({
      readDirectory: async () => {
        controller.abort();
        return ["src"];
      },
      runGit: async () => ({ ok: false }),
      utcDate: () => "2026-08-10",
      platform: "linux",
      homeDir: "/home/user",
      workspaceRoots: () => ["/workspace"],
    });

    await expect(
      snapshot.snapshot({ projectDir: "/workspace", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
