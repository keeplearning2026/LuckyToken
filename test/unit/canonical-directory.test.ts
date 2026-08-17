import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRealFilesystemCanonicalDirectoryResolver,
  resolveCanonicalDirectory,
} from "../../src/client-auth/canonical-directory.js";

/**
 * Backend-owned canonical directory contract (Ticket 17): every public
 * entry point (Control Plane handler, CLI, live authority) resolves an
 * input directory to its canonical real filesystem identity through this
 * contract. The acceptance proof lives in the Control Plane/CLI/HTTP
 * integration suites; these unit tests pin the failure taxonomy and the
 * injectable race detection.
 */
describe("canonical directory resolution", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "luckytoken-canonical-dir-"));
    directories.push(root);
    await mkdir(join(root, "project", "nested"), { recursive: true });
    return root;
  }

  it("resolves relative, dot, dotdot, and separator aliases to one canonical identity", async () => {
    const root = await fixture();
    const project = join(root, "project");
    const results = await Promise.all([
      resolveCanonicalDirectory(project),
      resolveCanonicalDirectory(join(project, ".", "nested", "..")),
      resolveCanonicalDirectory(join(root, "project", sep, "nested", "..")),
      resolveCanonicalDirectory(`.${sep}project`, root),
      resolveCanonicalDirectory("project", root),
      resolveCanonicalDirectory(join("..", "project"), join(root, "project")),
    ]);
    for (const result of results) {
      expect(result.outcome).toBe("ok");
      expect(result.outcome === "ok" ? result.canonicalDir : undefined).toBe(project);
    }
  });

  it("resolves one canonical identity across symlink aliases", async () => {
    const root = await fixture();
    const project = join(root, "project");
    const link = join(root, "project-link");
    await symlink(project, link, "junction").catch(() =>
      symlink(project, link, "dir"),
    );
    const direct = await resolveCanonicalDirectory(project);
    const viaLink = await resolveCanonicalDirectory(link);
    expect(direct.outcome).toBe("ok");
    expect(viaLink.outcome).toBe("ok");
    expect(
      viaLink.outcome === "ok" ? viaLink.canonicalDir : undefined,
    ).toBe(direct.outcome === "ok" ? direct.canonicalDir : undefined);
  });

  it("rejects a nonexistent path with not_found", async () => {
    const root = await fixture();
    await expect(
      resolveCanonicalDirectory(join(root, "missing")),
    ).resolves.toEqual({ outcome: "not_found" });
  });

  it("rejects a file instead of a directory with not_a_directory", async () => {
    const root = await fixture();
    const file = join(root, "file.txt");
    await writeFile(file, "content");
    const direct = await resolveCanonicalDirectory(file);
    expect(direct.outcome).toBe("not_a_directory");
    // A real symlink to a file is also not a directory. Windows cannot
    // create a real file symlink without privilege, and a "junction" to a
    // file is a broken reparse point that realpath reports as not_found;
    // both are honest outcomes, so the alias mechanic is guarded off.
    if (process.platform !== "win32") {
      const fileLink = join(root, "file-link");
      await symlink(file, fileLink, "file");
      await expect(resolveCanonicalDirectory(fileLink)).resolves.toEqual({
        outcome: "not_a_directory",
      });
    }
  });

  it("rejects invalid path values without touching the filesystem", async () => {
    await expect(resolveCanonicalDirectory("")).resolves.toEqual({
      outcome: "invalid",
    });
    await expect(
      resolveCanonicalDirectory("has\u0000nul"),
    ).resolves.toEqual({ outcome: "invalid" });
  });

  it("reports inaccessible directories without leaking the path", async () => {
    const resolver = createRealFilesystemCanonicalDirectoryResolver({
      async realpath() {
        const error = new Error("EACCES") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    });
    const result = await resolver.resolve("C:\\blocked\\dir");
    expect(result.outcome).toBe("inaccessible");
    expect(JSON.stringify(result)).not.toContain("blocked");
  });

  it("detects a target race when the resolved identity changes mid-resolution", async () => {
    let calls = 0;
    const resolver = createRealFilesystemCanonicalDirectoryResolver({
      async realpath() {
        calls += 1;
        return calls === 1
          ? "C:\\projects\\before"
          : "C:\\projects\\after";
      },
      async stat() {
        return { isDirectory: () => true };
      },
    });
    const result = await resolver.resolve("C:\\projects\\alias");
    expect(result.outcome).toBe("race");
    expect(calls).toBe(2);
  });

  it("detects a disappearing target during resolution as a race", async () => {
    let calls = 0;
    const resolver = createRealFilesystemCanonicalDirectoryResolver({
      async realpath() {
        calls += 1;
        if (calls === 1) return "C:\\projects\\existing";
        const error = new Error("ENOENT") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      async stat() {
        return { isDirectory: () => true };
      },
    });
    const result = await resolver.resolve("C:\\projects\\vanishing");
    expect(result.outcome).toBe("race");
    expect(calls).toBe(2);
  });

  it("never mutates the process working directory", async () => {
    const root = await fixture();
    const before = process.cwd();
    await resolveCanonicalDirectory(".", root);
    expect(process.cwd()).toBe(before);
  });
});
