import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadTokenCliConfig } from "../../src/cli-config.js";

describe("removed Client Token file configuration", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("rejects authFile instead of loading or migrating a token store", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-no-client-token-"));
    roots.push(root);
    const path = join(root, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "token-config-v2",
        clientProtocols: {
          "anthropic-messages": { authFile: "client-auth.json" },
        },
        pi: { directory: "pi" },
      }),
      "utf8",
    );

    await expect(loadTokenCliConfig(path)).rejects.toThrow(/authFile/u);
  });
});
