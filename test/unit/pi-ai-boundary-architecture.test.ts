import { access, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const protocolRoots = [
  "src/protocols/openai-responses",
  "src/protocols/anthropic",
] as const;

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function expectPathAbsent(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe("Pi AI semantic boundary architecture", () => {
  it("has no Client Protocol Provider-payload projection or supplement directory", async () => {
    for (const root of protocolRoots) {
      await expectPathAbsent(join(root, "semantic", "projection"));
      await expectPathAbsent(join(root, "semantic", "supplement"));
      await expectPathAbsent(join(root, "semantic", "pi-execution.ts"));
    }
  });

  it("keeps Client Protocol production code above the Provider boundary", async () => {
    for (const root of protocolRoots) {
      for (const file of await collectTypeScriptFiles(root)) {
        const source = await readFile(file, "utf8");
        const label = relative(process.cwd(), file);

        expect(source, label).not.toMatch(/\bonPayload\b/u);
        expect(source, label).not.toMatch(/\bTranscriptContext\b/u);
        expect(source, label).not.toMatch(/\bnormalizeContext\b/u);
        expect(source, label).not.toMatch(/provider-commandcode-private/u);
        expect(source, label).not.toMatch(/\bprojectPayload\b/u);
        expect(source, label).not.toMatch(/\bProjectionOutcome\b/u);
        expect(source, label).not.toMatch(/\bProjectionSupplement\b/u);
      }
    }
  });

  it("keeps Provider-native reasoning fields out of Client Protocol code", async () => {
    for (const root of protocolRoots) {
      for (const file of await collectTypeScriptFiles(root)) {
        const source = await readFile(file, "utf8");
        const label = relative(process.cwd(), file);

        expect(source, label).not.toMatch(/\breasoning_effort\b/u);
        expect(source, label).not.toMatch(/\bthinkingConfig\b/u);
      }
    }
  });

  it("keeps mid-system capability policy out of Client converters and neutral execution", async () => {
    for (const root of protocolRoots) {
      for (const file of await collectTypeScriptFiles(root)) {
        if (!file.endsWith("request.ts")) continue;
        const source = await readFile(file, "utf8");
        expect(source, relative(process.cwd(), file)).not.toContain(
          "supportsMidConvoSystemMessages",
        );
      }
    }
    const execution = await readFile("src/execution.ts", "utf8");
    expect(execution).not.toContain("preparePiContextForModel");
  });

  it("keeps Pi Context compatibility model-agnostic apart from the public capability", async () => {
    const source = await readFile("src/pi-context-compatibility.ts", "utf8");
    expect(source).not.toMatch(/model\.provider/u);
    expect(source).not.toMatch(/model\.id/u);
    expect(source).not.toMatch(/model\.api/u);
    expect(source).not.toMatch(/provider\s*===/u);
  });

  it("makes CommandCode Private consume TranscriptContext and own its wire", async () => {
    const source = await readFile(
      "packages/provider-commandcode-private/src/provider.ts",
      "utf8",
    );

    expect(source).toContain("type TranscriptContext");
    expect(source).toContain("collapseSystemMessages(context)");
    expect(source).toContain("getCurrentSystemPrompt(collapsed.messages)");
    expect(source).toContain("getCurrentTools(collapsed.messages)");
    expect(source).toContain("params.reasoning_effort = reasoning.effort");
  });

  it("exposes bundled Provider packages only through their registration contract", async () => {
    for (const file of [
      "packages/provider-commandcode-private/src/index.ts",
      "packages/provider-commandcode-goat/src/index.ts",
    ]) {
      const source = await readFile(file, "utf8");
      expect(source, file).toContain("export const providerPackage");
      expect(source, file).not.toMatch(/export\s+\{\s*createCommandCode/u);
      expect(source, file).not.toMatch(/export\s+type\s+\{[^}]*ProviderOptions/su);
    }
  });
});
