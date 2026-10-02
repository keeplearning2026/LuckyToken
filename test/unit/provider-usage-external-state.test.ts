import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";

import { createCodexLocalAcquisition } from "../../src/credentials/acquisition.js";
import { createProviderCredentialProfiles } from "../../src/credentials/profile-authority.js";
import {
  createInMemoryProviderCredentialRecordStore,
} from "../../src/credentials/profile-record-store.js";
import { createProviderUsageAuthority } from "../../src/provider-usage/authority.js";
import type { ProviderUsageProbe } from "../../src/provider-usage/contract.js";

const providerId = "openai-codex";
const provider = builtinProviders().find((item) => item.id === providerId)!;

function documentFor(account: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const access = [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
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
      refresh_token: "refresh-" + account,
      account_id: account,
    },
  });
}

async function setup(authPath: string, usageProbe: ProviderUsageProbe) {
  const profiles = createProviderCredentialProfiles({
    recordStore: createInMemoryProviderCredentialRecordStore({
      createRevision: randomUUID,
    }),
    providers: () => [provider],
    createId: randomUUID,
    now: Date.now,
  });
  const acquisition = createCodexLocalAcquisition({
    authPath,
    label: () => provider.auth.oauth?.name,
  });
  await profiles.management.acquireLocal({
    providerId,
    displayName: "Codex local",
    acquisition,
  });
  const models = createModels({ credentials: profiles.credentialStore });
  models.setProvider(provider);
  const usage = createProviderUsageAuthority({
    models,
    binding: profiles.binding,
    profileSnapshot: () => profiles.management.snapshot(),
    probes: [usageProbe],
    now: () => 1_000,
  });
  return { profiles, usage };
}

describe("external Profile Usage identity", () => {
  it("invalidates cached usage when external credential bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-usage-external-"));
    try {
      const authPath = join(root, "auth.json");
      await writeFile(authPath, documentFor("account-a"), "utf8");
      const value = await setup(authPath, {
        providerId,
        eligibility: () => ({ state: "eligible" }),
        acquire: async () => ({
          state: "observed",
          facts: {
            windows: [{ kind: "weekly", usedPercent: 10 }],
            budgets: [],
          },
        }),
      });

      const first = await value.usage.refresh(providerId);
      expect(first.refresh.outcome).toBe("succeeded");
      expect(first.snapshot.profiles[0]?.state).toBe("observed");

      await writeFile(authPath, documentFor("account-b"), "utf8");
      const second = await value.usage.query();
      expect(second.profiles[0]).toMatchObject({
        providerId,
        state: "unobserved",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supersedes a refresh result when external bytes change before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "Token-usage-external-race-"));
    try {
      const authPath = join(root, "auth.json");
      await writeFile(authPath, documentFor("account-a"), "utf8");
      let entered!: () => void;
      const acquisitionEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const value = await setup(authPath, {
        providerId,
        eligibility: () => ({ state: "eligible" }),
        acquire: async () => {
          entered();
          await gate;
          return {
            state: "observed",
            facts: {
              windows: [{ kind: "weekly", usedPercent: 55 }],
              budgets: [],
            },
          };
        },
      });

      const pending = value.usage.refresh(providerId);
      await acquisitionEntered;
      await writeFile(authPath, documentFor("account-b"), "utf8");
      release();

      const result = await pending;
      expect(result.refresh.outcome).toBe("superseded");
      expect(result.snapshot.profiles[0]?.state).toBe("unobserved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
