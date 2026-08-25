import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTokenCliConfig } from "../../src/cli-config.js";
import {
  OwnedFileCompatibilityError,
  inspectOwnedCompatibility,
} from "../../src/owned-storage/index.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Ticket 24 owned-file compatibility preflight", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("rejects a missing or future config schema with an exact typed issue and preserves the source bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-t24-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: "token-config-v999",
        clientProtocols: {},
        pi: { directory: "pi" },
      }),
    );
    await writeFile(path, bytes);

    let thrown: unknown;
    try {
      await loadTokenCliConfig(path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OwnedFileCompatibilityError);
    expect((thrown as OwnedFileCompatibilityError).issue).toEqual({
      path,
      contract: "token-config",
      foundVersion: "token-config-v999",
      expectedVersion: "token-config-v2",
      validationError:
        "Token config schemaVersion is incompatible with this application build.",
    });
    expect(await readFile(path)).toEqual(bytes);
  });

  it("does not read or reinterpret dormant legacy diagnostics and client-auth files", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-t24-preflight-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const tokenPath = join(root, "anthropic-client-tokens.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "token-config-v2",
        clientProtocols: {
          "anthropic-messages": {},
        },
        pi: { directory: "pi" },
      }),
    );
    await writeFile(
      tokenPath,
      JSON.stringify({
        schemaVersion: "Token-client-auth-v1",
        global: "legacy-token-canary",
        projects: {},
      }),
    );
    const ledgerDir = join(root, "state", "request-ledger");
    await mkdir(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "ledger.sqlite3");
    await writeFile(ledgerPath, "dormant-legacy-ledger-canary");
    const beforeLedger = await readFile(ledgerPath);
    const beforeToken = await readFile(tokenPath);

    const config = await loadTokenCliConfig(configPath);
    const issues = await inspectOwnedCompatibility(config);
    expect(issues).toEqual([]);
    expect(sha256(await readFile(ledgerPath))).toBe(sha256(beforeLedger));
    expect(sha256(await readFile(tokenPath))).toBe(sha256(beforeToken));
    expect(issues.some((issue) => issue.path === tokenPath)).toBe(false);
  });

  it("does not reinterpret current providerPackages semantic errors as owned-file compatibility issues", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-t24-current-config-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: "token-config-v2",
        clientProtocols: {
          "anthropic-messages": {},
        },
        providerPackages: {
          "@token/provider-commandcode-private": {},
        },
        pi: { directory: "pi" },
      }),
    );

    const config = await loadTokenCliConfig(configPath);
    await expect(inspectOwnedCompatibility(config)).resolves.toEqual([]);
  });
});
