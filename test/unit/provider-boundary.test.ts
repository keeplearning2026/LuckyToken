import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const coreModules = [
  "runtime.ts",
  "http.ts",
  "execution.ts",
  "model-resolution.ts",
  "protocols/anthropic/options.ts",
  "protocols/anthropic/failures.ts",
  "protocols/anthropic/handler.ts",
  "protocols/anthropic/options.ts",
  "protocols/anthropic/profile.ts",
  "protocols/anthropic/representability.ts",
  "protocols/anthropic/request.ts",
  "protocols/anthropic/response.ts",
  "protocols/anthropic/sse.ts",
  "protocols/anthropic/tools.ts",
  "protocols/anthropic/wire.ts",
] as const;

const genericRuntimeModules = [
  "runtime.ts",
  "http.ts",
  "execution.ts",
  "model-resolution.ts",
] as const;

const commandCodeProviderModules = [
  "providers/commandcode-private/assembler.ts",
  "providers/commandcode-private/attempts.ts",
  "providers/commandcode-private/json.ts",
  "providers/commandcode-private/model.ts",
  "providers/commandcode-private/project.ts",
  "providers/commandcode-private/provider.ts",
  "providers/commandcode-private/semantic.ts",
] as const;

describe("Provider architecture boundary", () => {
  it("keeps Core dependent on Pi rather than concrete Providers", async () => {
    for (const module of coreModules) {
      const source = await readFile(new URL(`../../src/${module}`, import.meta.url), "utf8");
      expect(source, module).not.toMatch(/(?:\.\.\/)*providers\//u);
      expect(source, module).not.toMatch(/commandcode|CommandCode/u);
    }
  });

  it("keeps concrete serving certification out of HTTP execution", async () => {
    const source = await readFile(
      new URL("../../src/http.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from ["']\.\/certification\.js["']/u);
  });

  it("keeps generic Runtime independent of every Client Protocol", async () => {
    for (const module of genericRuntimeModules) {
      const source = await readFile(new URL(`../../src/${module}`, import.meta.url), "utf8");
      expect(source, module).not.toMatch(/protocols\/anthropic|Anthropic|anthropic/u);
    }
  });

  it("keeps Providers independent of Client Protocol semantics", async () => {
    for (const module of commandCodeProviderModules) {
      const source = await readFile(new URL(`../../src/${module}`, import.meta.url), "utf8");
      expect(source, module).not.toMatch(/Anthropic|anthropic/u);
    }
  });
});
