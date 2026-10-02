import { readExternalCredentialFile } from "../../src/credentials/external-credential-file.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCodexExternalAuth,
  resolveCodexAccountIdentity,
} from "../../src/credentials/codex-auth.js";



const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "Token-codex-external-auth-"));
  roots.push(root);
  return root;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const ACCOUNT_CLAIM = "https://api.openai.com/auth";

function accessToken(
  payload: Record<string, unknown>,
  options: { readonly nested?: string | undefined } = {},
): string {
  const nested = options.nested === undefined ? "acct-nested" : options.nested;
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...payload,
      ...(nested === undefined
        ? {}
        : { [ACCOUNT_CLAIM]: { chatgpt_account_id: nested } }),
    }),
    "signature",
  ].join(".");
}

function chatGptDocument(options: {
  readonly accessToken?: string;
  readonly accountId?: string;
  readonly lastRefresh?: string;
  readonly authMode?: string;
} = {}): string {
  return JSON.stringify({
    auth_mode: options.authMode ?? "chatgpt",
    tokens: {
      access_token: options.accessToken ?? accessToken({}),
      refresh_token: "refresh-token",
      ...(options.accountId === undefined ? {} : { account_id: options.accountId }),
    },
    ...(options.lastRefresh === undefined
      ? {}
      : { last_refresh: options.lastRefresh }),
  });
}

describe("Codex external auth claim intersection", () => {
  it("accepts a nested-only account claim", () => {
    expect(resolveCodexAccountIdentity(accessToken({}), undefined)).toEqual({
      accountId: "acct-nested",
    });
  });

  it("rejects a top-level-only account claim", () => {
    const identity = resolveCodexAccountIdentity(
      ["header", encode({ exp: 1, chatgpt_account_id: "acct-top" }), "sig"].join("."),
      undefined,
    );
    expect(identity).toHaveProperty("error");
  });

  it("accepts matching top-level and tokens.account_id values", () => {
    expect(
      resolveCodexAccountIdentity(
        accessToken({ chatgpt_account_id: "acct-nested" }),
        "acct-nested",
      ),
    ).toEqual({ accountId: "acct-nested" });
  });

  it("rejects any conflict between the three claim locations", () => {
    expect(
      resolveCodexAccountIdentity(
        accessToken({ chatgpt_account_id: "acct-other" }),
        "acct-nested",
      ),
    ).toHaveProperty("error");
    expect(
      resolveCodexAccountIdentity(accessToken({}), "acct-other"),
    ).toHaveProperty("error");
  });
});

describe("Codex external auth document parsing", () => {
  it("parses a ChatGPT document and derives the numeric expiry", () => {
    const parsed = parseCodexExternalAuth(chatGptDocument({ accountId: "acct-nested" }));
    expect(parsed.state).toBe("ok");
    if (parsed.state !== "ok") return;
    expect(parsed.auth.accountId).toBe("acct-nested");
    expect(parsed.auth.expiresAt).toBeGreaterThan(Date.now());
    expect(parsed.auth.credential?.accessToken).toBeTruthy();
    expect(parsed.auth.credential?.refreshToken).toBe("refresh-token");
  });

  it("never coerces a non-ChatGPT auth mode into ChatGPT tokens", () => {
    const parsed = parseCodexExternalAuth(
      chatGptDocument({ authMode: "apikey" }),
    );
    expect(parsed.state).toBe("invalid");
  });

  it("treats an unparseable expiry as needing Codex delegation, not as live", () => {
    const token = [
      encode({ alg: "none" }),
      encode({ [ACCOUNT_CLAIM]: { chatgpt_account_id: "acct-nested" } }),
      "sig",
    ].join(".");
    const parsed = parseCodexExternalAuth(
      chatGptDocument({
        accessToken: token,
        lastRefresh: new Date(Date.now() - 9 * 24 * 3600_000).toISOString(),
      }),
    );
    expect(parsed.state).toBe("ok");
    if (parsed.state !== "ok") return;
    expect(parsed.auth.expiresAt).toBeUndefined();
    expect(parsed.auth.credential).toBeUndefined();
  });

  it("rejects invalid JSON", () => {
    expect(parseCodexExternalAuth("{truncated").state).toBe("invalid");
  });
});

describe("Codex external auth reads", () => {
  it("distinguishes missing, invalid, unreadable, and ok", async () => {
    const root = await home();
    const authPath = join(root, "auth.json");
    const source = { read: () => readExternalCredentialFile(authPath) };
    await expect(source.read()).resolves.toMatchObject({
      state: "missing",
    });
    await writeFile(authPath, "{", "utf8");
    await expect(source.read()).resolves.toMatchObject({
      state: "ok",
    });
    await rm(authPath, { force: true });
    await mkdir(authPath, { recursive: true });
    await expect(source.read()).resolves.toMatchObject({
      state: "unreadable",
    });
    await rm(authPath, { recursive: true, force: true });
    await writeFile(authPath, chatGptDocument(), "utf8");
    const read = await source.read();
    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    const repeated = await source.read();
    expect(repeated.state).toBe("ok");
    if (repeated.state !== "ok") return;
    expect(repeated.tokenRevision).toBe(read.tokenRevision);
    await writeFile(authPath, `${chatGptDocument()}\n`, "utf8");
    const changed = await source.read();
    expect(changed.state).toBe("ok");
    if (changed.state !== "ok") return;
    expect(changed.tokenRevision).not.toBe(read.tokenRevision);
  });
});
