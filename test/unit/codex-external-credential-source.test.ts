import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CodexAppServerRefresher,
  CodexRefreshDelegationOutcome,
} from "../../src/credentials/codex-app-server-refresh.js";
import { createCodexExternalCredentialSource } from "../../src/credentials/codex-external-credential-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{ readonly root: string; readonly authPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "Token-external-source-"));
  roots.push(root);
  return { root, authPath: join(root, "auth.json") };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function document(options: {
  readonly expiresInSeconds: number;
  readonly accountId: string;
  readonly accessTokenSuffix?: string;
}): string {
  const token = [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor(Date.now() / 1000) + options.expiresInSeconds,
      "https://api.openai.com/auth": {
        chatgpt_account_id: options.accountId,
      },
      jti: options.accessTokenSuffix ?? "a",
    }),
    "signature",
  ].join(".");
  return `${JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: token,
      refresh_token: "refresh-token",
      account_id: options.accountId,
    },
    last_refresh: new Date().toISOString(),
  })}\n`;
}

function countingRefresher(
  outcome: CodexRefreshDelegationOutcome = { outcome: "completed" },
): {
  readonly refresher: CodexAppServerRefresher;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    refresher: {
      inflightCount: () => 0,
      async refresh() {
        calls += 1;
        return outcome;
      },
    },
  };
}

describe("external credential resolution boundary", () => {
  it.each([
    [240_000, false], [300_000, false], [300_001, true], [360_000, true],
  ])("enforces the real resolution window at %s milliseconds", async (validFor, live) => {
    const { authPath } = await fixture();
    const now = 1_800_000_000_000;
    const access = [encode({ alg: "none" }), encode({ exp: (now + validFor) / 1000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-a" } }), "sig"].join(".");
    await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens: {
      access_token: access, refresh_token: "synthetic-refresh", account_id: "acct-a",
    } }));
    const { refresher, calls } = countingRefresher({ outcome: "unavailable", reason: "no_runtime" });
    const source = createCodexExternalCredentialSource({ authPath, refresher, now: () => now,
      minimumValidityMs: 60_000 });
    expect((await source.resolve()).state).toBe(live ? "ok" : "unavailable");
    expect(calls()).toBe(live ? 0 : 1);
  });

  it("requires stronger adapter validity and delegates unknown expiry regardless of last_refresh", async () => {
    const { authPath } = await fixture();
    const { refresher, calls } = countingRefresher({ outcome: "unavailable", reason: "no_runtime" });
    await writeFile(authPath, document({ expiresInSeconds: 360, accountId: "acct-a" }));
    const source = createCodexExternalCredentialSource({ authPath, refresher, minimumValidityMs: 600_000 });
    expect((await source.resolve()).state).toBe("unavailable");
    expect(calls()).toBe(1);
    for (const last_refresh of [new Date().toISOString(), new Date(0).toISOString()]) {
      await writeFile(authPath, JSON.stringify({ auth_mode: "chatgpt", last_refresh, tokens: {
        access_token: [encode({ alg: "none" }), encode({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-a" } }), "sig"].join("."),
        refresh_token: "synthetic-refresh", account_id: "acct-a",
      } }));
      expect(await source.read()).toMatchObject({ state: "ok", identityKey: "acct-a" });
      expect(await source.resolve()).toMatchObject({ state: "unavailable", reason: "refresh_unavailable" });
    }
    expect(calls()).toBe(3);
  });

  it("resolves a fresh credential without delegating", async () => {
    const { authPath } = await fixture();
    await writeFile(authPath, document({ expiresInSeconds: 3600, accountId: "acct-a" }));
    const { refresher, calls } = countingRefresher();
    const source = createCodexExternalCredentialSource({ authPath, refresher });

    const resolution = await source.resolve();

    expect(resolution.state).toBe("ok");
    if (resolution.state !== "ok") return;
    expect(resolution.refreshed).toBe(false);
    expect(resolution.identityKey).toBe("acct-a");
    expect(calls()).toBe(0);
  });

  it("delegates a near-expiry credential and verifies the re-read", async () => {
    const { authPath } = await fixture();
    await writeFile(authPath, document({ expiresInSeconds: 120, accountId: "acct-a" }));
    const { refresher } = countingRefresher();
    // Simulate the Codex-native in-place refresh landing after delegation.
    const delegate: typeof refresher.refresh = async () => {
      await writeFile(
        authPath,
        document({ expiresInSeconds: 3600, accountId: "acct-a", accessTokenSuffix: "b" }),
      );
      return { outcome: "completed" };
    };
    const source = createCodexExternalCredentialSource({
      authPath,
      refresher: { ...refresher, refresh: delegate },
      retryDelayMs: 0,
    });

    const resolution = await source.resolve();

    expect(resolution.state).toBe("ok");
    if (resolution.state !== "ok") return;
    expect(resolution.refreshed).toBe(true);
  });

  it("fails closed when delegation is unavailable", async () => {
    const { authPath } = await fixture();
    await writeFile(authPath, document({ expiresInSeconds: 60, accountId: "acct-a" }));
    const source = createCodexExternalCredentialSource({
      authPath,
      refresher: countingRefresher({ outcome: "unavailable", reason: "no_runtime" })
        .refresher,
      retryDelayMs: 0,
    });

    await expect(source.resolve()).resolves.toMatchObject({
      state: "unavailable",
      reason: "refresh_unavailable",
    });
  });

  it("rejects an unchanged revision, an account change, and insufficient validity", async () => {
    const cases: readonly {
      readonly name: string;
      readonly next: (path: string) => Promise<void>;
    }[] = [
      {
        name: "unchanged",
        next: async () => undefined,
      },
      {
        name: "account-changed",
        next: (path: string) =>
          writeFile(
            path,
            document({ expiresInSeconds: 3600, accountId: "acct-b", accessTokenSuffix: "b" }),
          ),
      },
      {
        name: "insufficient",
        next: (path: string) =>
          writeFile(
            path,
            document({ expiresInSeconds: 30, accountId: "acct-a", accessTokenSuffix: "c" }),
          ),
      },
    ];
    for (const testCase of cases) {
      const { authPath } = await fixture();
      await writeFile(authPath, document({ expiresInSeconds: 60, accountId: "acct-a" }));
      const source = createCodexExternalCredentialSource({
        authPath,
        refresher: {
          inflightCount: () => 0,
          async refresh() {
            await testCase.next(authPath);
            return { outcome: "completed" };
          },
        },
        retryDelayMs: 0,
      });
      const resolution = await source.resolve();
      expect(resolution.state, testCase.name).toBe("unavailable");
      if (resolution.state !== "unavailable") continue;
      expect(resolution.reason, testCase.name).toBe("verification_failed");
    }
  });

  it("retries a transient invalid document within its bounded budget", async () => {
    const { authPath } = await fixture();
    await writeFile(authPath, "{");
    const source = createCodexExternalCredentialSource({
      authPath,
      refresher: countingRefresher().refresher,
      retryDelayMs: 20,
      readAttempts: 3,
    });
    const pending = source.resolve();
    await writeFile(authPath, document({ expiresInSeconds: 3600, accountId: "acct-a" }));

    const resolution = await pending;
    expect(resolution.state).toBe("ok");
  });

  it("reports a missing document without delegating", async () => {
    const { authPath } = await fixture();
    const { refresher, calls } = countingRefresher();
    const source = createCodexExternalCredentialSource({ authPath, refresher });

    await expect(source.resolve()).resolves.toMatchObject({
      state: "unavailable",
      reason: "missing",
    });
    expect(calls()).toBe(0);
  });

  it("never writes the Codex-owned document", async () => {
    const { authPath } = await fixture();
    await writeFile(authPath, document({ expiresInSeconds: 3600, accountId: "acct-a" }));
    const before = await readFile(authPath, "utf8");
    const source = createCodexExternalCredentialSource({
      authPath,
      refresher: countingRefresher().refresher,
    });

    await source.resolve();
    await expect(
      source.resolve({ signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();

    expect(await readFile(authPath, "utf8")).toBe(before);
  });

  it("recovers a non-atomic app-server write window within the retry budget", async () => {
    const { authPath } = await fixture();
    // Empty file, then truncated JSON, then a complete document.
    await writeFile(authPath, "");
    const source = createCodexExternalCredentialSource({
      authPath,
      refresher: countingRefresher().refresher,
      retryDelayMs: 20,
      readAttempts: 4,
    });
    const pending = source.resolve();
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    await writeFile(authPath, '{"auth_mode":"chatgpt","tokens":');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await writeFile(
      authPath,
      document({ expiresInSeconds: 3600, accountId: "acct-a" }),
    );

    await expect(pending).resolves.toMatchObject({ state: "ok" });
  });
});
