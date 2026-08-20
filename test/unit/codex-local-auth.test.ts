import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCodexLocalCredentialAuthority } from "../../src/integrations/codex/local-auth.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createHome(auth: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "luckytoken-codex-auth-"));
  homes.push(home);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "auth.json"), `${JSON.stringify(auth)}\n`, "utf8");
  return home;
}

describe("Codex local credential authority", () => {
  it("resolves forwarding auth only for the current file-backed Codex access token", async () => {
    const home = await createHome({
      tokens: { access_token: "codex-access-a", account_id: "acct-a" },
    });
    const authority = createCodexLocalCredentialAuthority({ codexHome: home });

    await expect(
      authority.resolveForwardAuth(
        new Headers({ authorization: "Bearer codex-access-a" }),
      ),
    ).resolves.toEqual({
      authorization: "Bearer codex-access-a",
      accountId: "acct-a",
    });
    await expect(
      authority.resolveForwardAuth(new Headers({ authorization: "Bearer wrong" })),
    ).resolves.toBeUndefined();
  });

  it("re-reads auth.json on every request so a Codex refresh takes effect without restarting LuckyToken", async () => {
    const home = await createHome({
      tokens: { access_token: "codex-access-a", account_id: "acct-a" },
    });
    const authority = createCodexLocalCredentialAuthority({ codexHome: home });

    await expect(
      authority.resolveForwardAuth(new Headers({ authorization: "Bearer codex-access-a" })),
    ).resolves.toMatchObject({ authorization: "Bearer codex-access-a" });

    const replacement = join(home, "auth.next.json");
    await writeFile(
      replacement,
      `${JSON.stringify({ tokens: { access_token: "codex-access-b", account_id: "acct-b" } })}\n`,
      "utf8",
    );
    await rename(replacement, join(home, "auth.json"));

    await expect(
      authority.resolveForwardAuth(new Headers({ authorization: "Bearer codex-access-a" })),
    ).resolves.toBeUndefined();
    await expect(
      authority.resolveForwardAuth(new Headers({ authorization: "Bearer codex-access-b" })),
    ).resolves.toEqual({
      authorization: "Bearer codex-access-b",
      accountId: "acct-b",
    });
  });

  it("fails closed for missing, malformed, or incomplete auth.json", async () => {
    const missing = await mkdtemp(join(tmpdir(), "luckytoken-codex-auth-missing-"));
    homes.push(missing);
    const missingAuthority = createCodexLocalCredentialAuthority({ codexHome: missing });
    await expect(
      missingAuthority.resolveForwardAuth(new Headers({ authorization: "Bearer anything" })),
    ).resolves.toBeUndefined();

    const malformed = await mkdtemp(join(tmpdir(), "luckytoken-codex-auth-bad-"));
    homes.push(malformed);
    await writeFile(join(malformed, "auth.json"), "{bad json", "utf8");
    const malformedAuthority = createCodexLocalCredentialAuthority({ codexHome: malformed });
    await expect(
      malformedAuthority.resolveForwardAuth(new Headers({ authorization: "Bearer anything" })),
    ).resolves.toBeUndefined();

    const incomplete = await createHome({ tokens: { account_id: "acct" } });
    const incompleteAuthority = createCodexLocalCredentialAuthority({ codexHome: incomplete });
    await expect(
      incompleteAuthority.resolveForwardAuth(new Headers({ authorization: "Bearer anything" })),
    ).resolves.toBeUndefined();
  });

  it("never accepts x-api-key as the Codex forwarding credential", async () => {
    const home = await createHome({
      tokens: { access_token: "codex-access", account_id: "acct" },
    });
    const authority = createCodexLocalCredentialAuthority({ codexHome: home });

    await expect(
      authority.resolveForwardAuth(new Headers({ "x-api-key": "codex-access" })),
    ).resolves.toBeUndefined();
  });

  it("scrubs the current Codex access token without exposing it", async () => {
    const home = await createHome({
      tokens: { access_token: "codex-secret-access", account_id: "acct" },
    });
    const authority = createCodexLocalCredentialAuthority({ codexHome: home });

    expect(authority.scrub("before codex-secret-access after")).toBe("before [REDACTED] after");
  });
});
