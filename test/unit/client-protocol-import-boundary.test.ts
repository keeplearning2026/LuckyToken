import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function importsUnder(directory: string): Promise<string> {
  const entries = await readdir(directory, { recursive: true });
  const sources = entries.filter((entry) => entry.endsWith(".ts"));
  return (await Promise.all(sources.map((entry) => readFile(resolve(directory, entry), "utf8")))).join("\n");
}

describe("Client Protocol import boundary", () => {
  it("prevents Anthropic and Responses from importing one another", async () => {
    const root = resolve("src/protocols");
    expect(await importsUnder(resolve(root, "anthropic"))).not.toMatch(/openai-responses/u);
    expect(await importsUnder(resolve(root, "openai-responses"))).not.toMatch(/protocols[\\/]anthropic|\.\.\/[\w-]*anthropic/u);
  });
});
