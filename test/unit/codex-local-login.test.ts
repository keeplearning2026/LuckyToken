import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";

import { createCodexLocalAcquisition } from "../../src/credentials/acquisition.js";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import {
  createInMemoryProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import {
  isProfileProviderAuthBindingCapture,
} from "../../src/credentials/profile-contract.js";

const providerId = "openai-codex";
const provider = builtinProviders().find((item) => item.id === providerId)!;

function syntheticDocument(
  account: string,
  expires = Date.now() + 3_600_000,
): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor(expires / 1000),
      "https://api.openai.com/auth": {
        chatgpt_account_id: account,
      },
    }),
    "signature",
  ].join(".");
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: access,
      refresh_token: `refresh-${account}`,
      account_id: account,
    },
  });
}

async function isolated(
  operation: (authPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "Token-local-oauth-"));
  try {
    await operation(join(root, "auth.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fixture(authPath: string) {
  const store = createInMemoryProviderCredentialRecordStore({
    createRevision: randomUUID,
  });
  const profiles = createProviderCredentialProfiles({
    recordStore: store,
    providers: () => [provider],
    createId: randomUUID,
    now: Date.now,
  });
  const acquisition = createCodexLocalAcquisition({
    authPath,
    label: () => provider.auth.oauth?.name,
  });
  return { store, profiles, acquisition };
}

describe("Codex local OAuth Profile", () => {
  it("stores only an external reference and reads current owner bytes", async () =>
    isolated(async (authPath) => {
      await writeFile(authPath, syntheticDocument("account-a"), "utf8");
      const value = fixture(authPath);

      const added = await value.profiles.management.acquireLocal({
        providerId,
        displayName: "Codex local",
        acquisition: value.acquisition,
      });
      expect(added.outcome).toBe("ok");

      const record = await value.store.read(providerId);
      expect(record?.profiles).toHaveLength(1);
      expect(record?.profiles[0]).toMatchObject({
        acquisitionKind: "local_oauth",
        displayName: "Codex local",
        reference: { owner: "external" },
      });
      expect(JSON.stringify(record)).not.toContain("access_token");
      expect(JSON.stringify(record)).not.toContain("refresh-account-a");

      const capture = await value.profiles.binding.capture(providerId);
      if (!isProfileProviderAuthBindingCapture(capture)) {
        throw new Error("expected local Profile capture");
      }
      const first = await value.profiles.binding.runBound(
        capture,
        () => value.profiles.credentialStore.read(providerId),
      );
      expect(first).toMatchObject({
        type: "oauth",
        refresh: "refresh-account-a",
      });

      await writeFile(authPath, syntheticDocument("account-b"), "utf8");
      const secondCapture = await value.profiles.binding.capture(providerId);
      const second = await value.profiles.binding.runBound(
        secondCapture,
        () => value.profiles.credentialStore.read(providerId),
      );
      expect(second).toMatchObject({
        type: "oauth",
        refresh: "refresh-account-b",
      });
    }));

  it("local_oauth modify rereads external state and never executes the Pi callback", async () =>
    isolated(async (authPath) => {
      await writeFile(authPath, syntheticDocument("account-a"), "utf8");
      const value = fixture(authPath);
      await value.profiles.management.acquireLocal({
        providerId,
        displayName: "Codex local",
        acquisition: value.acquisition,
      });
      const capture = await value.profiles.binding.capture(providerId);
      const mutation = vi.fn(async () => ({
        type: "oauth" as const,
        access: "must-not-be-used",
        refresh: "must-not-be-used",
        expires: Date.now() + 10_000,
      }));

      await writeFile(authPath, syntheticDocument("account-b"), "utf8");
      const next = await value.profiles.binding.runBound(
        capture,
        () => value.profiles.credentialStore.modify(providerId, mutation),
      );

      expect(mutation).not.toHaveBeenCalled();
      expect(next).toMatchObject({
        type: "oauth",
        refresh: "refresh-account-b",
      });
    }));

  it("allows at most one local_oauth Profile even when the existing one is disabled", async () =>
    isolated(async (authPath) => {
      await writeFile(authPath, syntheticDocument("account-a"), "utf8");
      const value = fixture(authPath);
      const first = await value.profiles.management.acquireLocal({
        providerId,
        displayName: "Codex local",
        acquisition: value.acquisition,
      });
      expect(first.outcome).toBe("ok");
      const state = (await value.profiles.management.query([providerId]))
        .providers[0]!;
      const credentialId = state.profiles[0]!.credentialId;
      await value.profiles.management.setEnabled({
        providerId,
        credentialId,
        enabled: false,
        expectedRevision: state.revision!,
      });

      const duplicate = await value.profiles.management.acquireLocal({
        providerId,
        displayName: "Another local",
        acquisition: value.acquisition,
      });
      expect(duplicate.outcome).toBe("duplicate");
    }));
});
