import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NO_PROVIDER_RECORD_REVISION, createInMemoryProviderCredentialRecordStore } from "../../src/credentials/profile-record-store.js";
import { loginOnlineProvider } from "../online/provider-login.js";
import { createConfiguredPiModels } from "../support/configured-data-plane.js";

describe("online Provider login", () => {
  it("persists login through an exact Provider Profile binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "luckytoken-online-login-"));
    try {
      const credentialRecordStore = createInMemoryProviderCredentialRecordStore({
        createRevision: randomUUID,
      });
      const runtime = await createConfiguredPiModels({
        piDirectory: directory,
        credentialRecordStore,
        fetch: async () => {
          throw new Error("online login must not dispatch a Provider request");
        },
      });

      await loginOnlineProvider({
        models: runtime.models,
        providerAuthBindings: runtime.providerAuthBindings,
        credentialManagement: runtime.credentialManagement,
        providerId: "commandcode-goat",
        authType: "api_key",
        displayName: "Online test",
        interaction: {
          prompt: async () => "test-only-key",
          notify: () => undefined,
        },
      });

      const state = await runtime.credentialManagement.query([
        "commandcode-goat",
      ]);
      expect(state.providers).toMatchObject([
        {
          providerId: "commandcode-goat",
          revision: expect.not.stringMatching(
            new RegExp(`^${NO_PROVIDER_RECORD_REVISION}$`, "u"),
          ),
          activeCredentialId: expect.any(String),
          profiles: [
            {
              authType: "api_key",
              displayName: "Online test",
              enabled: true,
            },
          ],
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
