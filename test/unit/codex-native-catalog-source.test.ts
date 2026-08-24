import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  codexDebugModelsInvocation,
  createCodexNativeCatalogSource,
} from "../../src/integrations/codex/native-catalog-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "luckytoken-codex-catalog-source-"));
  roots.push(codexHome);
  return codexHome;
}

describe("Codex native catalog source", () => {
  it("uses the installed Codex bundled catalog as the native snapshot", async () => {
    const codexHome = await home();
    const source = createCodexNativeCatalogSource({
      codexHome,
      runBundledCatalog: async () => JSON.stringify({
        models: [
          {
            slug: "gpt-native",
            display_name: "GPT Native",
            model_messages: { instructions_template: "You are Codex Native." },
          },
          {
            slug: "anthropic/claude-opus",
            display_name: "Routed row must not become Direct Mode",
          },
        ],
      }),
    });

    await expect(source.load()).resolves.toEqual({
      source: "bundled",
      entries: [
        {
          slug: "gpt-native",
          display_name: "GPT Native",
          model_messages: { instructions_template: "You are Codex Native." },
        },
      ],
      warnings: [],
    });
  });

  it("falls back to Codex models_cache.json when bundled discovery is unavailable", async () => {
    const codexHome = await home();
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "models_cache.json"),
      `${JSON.stringify({
        fetched_at: "2026-08-20T00:00:00Z",
        models: [
          { slug: "gpt-cache", display_name: "GPT Cache" },
          { slug: "provider/routed", display_name: "Routed" },
        ],
      })}\n`,
      "utf8",
    );
    const source = createCodexNativeCatalogSource({
      codexHome,
      runBundledCatalog: async () => {
        throw new Error("codex unavailable");
      },
    });

    const snapshot = await source.load();

    expect(snapshot.source).toBe("models-cache");
    expect(snapshot.entries).toEqual([{ slug: "gpt-cache", display_name: "GPT Cache" }]);
    expect(snapshot.warnings).toEqual([
      "Codex bundled model catalog is unavailable; using models_cache.json.",
    ]);
  });

  it("returns an empty native snapshot without disabling routed LuckyToken models when no Codex metadata exists", async () => {
    const codexHome = await home();
    const source = createCodexNativeCatalogSource({
      codexHome,
      runBundledCatalog: async () => {
        throw new Error("codex unavailable");
      },
    });

    await expect(source.load()).resolves.toEqual({
      source: "unavailable",
      entries: [],
      warnings: ["Codex native model metadata is unavailable."],
    });
  });

  it("tries discovered Codex runtimes in order until one yields a valid bundled catalog", async () => {
    const codexHome = await home();
    const calls: string[] = [];
    const source = createCodexNativeCatalogSource({
      codexHome,
      discoverCommands: async () => [
        "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe",
        "C:\\npm\\codex.cmd",
      ],
      runBundledCatalog: async (command) => {
        calls.push(command);
        if (command.endsWith("codex.exe")) throw new Error("broken desktop runtime");
        return JSON.stringify({ models: [{ slug: "gpt-from-cmd" }] });
      },
    });

    const snapshot = await source.load();

    expect(calls).toEqual([
      "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\new\\codex.exe",
      "C:\\npm\\codex.cmd",
    ]);
    expect(snapshot.source).toBe("bundled");
    expect(snapshot.entries).toEqual([{ slug: "gpt-from-cmd" }]);
  });

  it.runIf(process.platform === "win32")(
    "discovers the Codex Desktop runtime under LOCALAPPDATA before PATH fallback",
    async () => {
      const codexHome = await home();
      const localAppData = await mkdtemp(join(tmpdir(), "luckytoken-localappdata-"));
      roots.push(localAppData);
      const desktopBin = join(localAppData, "OpenAI", "Codex", "bin", "runtime-hash");
      await mkdir(desktopBin, { recursive: true });
      const desktopExe = join(desktopBin, "codex.exe");
      await writeFile(desktopExe, "fixture", "utf8");
      const calls: string[] = [];
      const source = createCodexNativeCatalogSource({
        codexHome,
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, PATH: "" },
        runBundledCatalog: async (command) => {
          calls.push(command);
          return JSON.stringify({ models: [{ slug: "gpt-desktop" }] });
        },
      });

      const snapshot = await source.load();

      expect(calls).toEqual([desktopExe]);
      expect(snapshot.entries).toEqual([{ slug: "gpt-desktop" }]);
    },
  );

  it.runIf(process.platform === "win32")(
    "executes a real Windows cmd shim through the bundled-catalog path",
    async () => {
      const codexHome = await home();
      const shim = join(codexHome, "codex.cmd");
      await writeFile(
        shim,
        '@echo off\r\necho {"models":[{"slug":"gpt-cmd-shim"}]}\r\n',
        "utf8",
      );
      const source = createCodexNativeCatalogSource({
        codexHome,
        codexCommand: shim,
        platform: "win32",
        env: { ...process.env, LOCALAPPDATA: "", PATH: "" },
      });

      const snapshot = await source.load();

      expect(snapshot.source).toBe("bundled");
      expect(snapshot.entries).toEqual([{ slug: "gpt-cmd-shim" }]);
    },
  );

  it("launches Windows cmd shims through ComSpec without shell=true", () => {
    const invocation = codexDebugModelsInvocation(
      "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
      "win32",
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toContain("codex.cmd");
    expect(invocation.args[3]).toContain("debug");
    expect(invocation.args[3]).toContain("models");
    expect(invocation.args[3]).toContain("--bundled");
    expect(invocation.options).toEqual({ windowsVerbatimArguments: true });
  });

  it("runs Windows exe runtimes directly", () => {
    const invocation = codexDebugModelsInvocation(
      "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe",
      "win32",
      {},
    );

    expect(invocation).toEqual({
      file: "C:\\Users\\test\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe",
      args: ["debug", "models", "--bundled"],
      options: {},
    });
  });

  it("treats malformed bundled output as unavailable and still uses the cache fallback", async () => {
    const codexHome = await home();
    await writeFile(
      join(codexHome, "models_cache.json"),
      `${JSON.stringify({ models: [{ slug: "gpt-cache" }] })}\n`,
      "utf8",
    );
    const source = createCodexNativeCatalogSource({
      codexHome,
      runBundledCatalog: async () => "not-json",
    });

    const snapshot = await source.load();

    expect(snapshot.source).toBe("models-cache");
    expect(snapshot.entries).toEqual([{ slug: "gpt-cache" }]);
  });
});
