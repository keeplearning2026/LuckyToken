import { describe, expect, it } from "vitest";

import {
  decodeCredentialProfilesCommand,
  decodeCredentialProfilesCommandResult,
  decodeProviderProfileAuthCommand,
  decodeProviderProfileAuthCommandResult,
} from "@luckytoken/application-control-plane/control-plane";

const state = {
  providers: [{
    providerId: "fixture-provider",
    implementationAvailable: true,
    revision: "revision-a",
    selectionGeneration: "selection-a",
    activeCredentialId: "credential-a",
    switchPolicy: { apiKeyOn429: false, oauthOn429: false },
    profiles: [{
      credentialId: "credential-a",
      authType: "api_key",
      authMethodLabel: "Fixture API key",
      displayName: "Production",
      identityHint: "•••• 1234",
      enabled: true,
      health: "ready",
      priority: 0,
      createdAt: 1,
      updatedAt: 2,
      lastUsedAt: 3,
      lastSucceededAt: 3,
    }],
  }],
} as const;

describe("Credential Profile public wire", () => {
  it("strictly decodes only the replacement management and auth commands", () => {
    expect(decodeCredentialProfilesCommand({
      command: "update_metadata",
      providerId: "fixture-provider",
      credentialId: "credential-a",
      displayName: "Release",
      note: "Primary",
      expectedRevision: "revision-a",
    })).toEqual({
      command: "update_metadata",
      providerId: "fixture-provider",
      credentialId: "credential-a",
      displayName: "Release",
      note: "Primary",
      expectedRevision: "revision-a",
    });
    expect(decodeCredentialProfilesCommand({
      command: "reorder_profiles",
      providerId: "fixture-provider",
      credentialIds: ["credential-b", "credential-a"],
      expectedRevision: "revision-a",
    })).toEqual({
      command: "reorder_profiles",
      providerId: "fixture-provider",
      credentialIds: ["credential-b", "credential-a"],
      expectedRevision: "revision-a",
    });
    expect(decodeProviderProfileAuthCommand({
      command: "login",
      providerId: "fixture-provider",
      authType: "api_key",
      displayName: "Production",
      useNow: true,
      expectedRevision: "absent",
    })).toEqual({
      command: "login",
      providerId: "fixture-provider",
      authType: "api_key",
      displayName: "Production",
      useNow: true,
      expectedRevision: "absent",
    });
    expect(decodeProviderProfileAuthCommand({
      command: "reconnect",
      providerId: "fixture-provider",
      credentialId: "credential-a",
      useNow: false,
      expectedRevision: "revision-a",
    })).toBeDefined();

    for (const obsolete of [
      { command: "logout", providerId: "fixture-provider", expectedRevision: 1 },
      { command: "import_preview", expectedRevision: 1, content: "{}" },
      { command: "login", providerId: "fixture-provider", value: "raw-secret" },
    ]) {
      expect(decodeCredentialProfilesCommand(obsolete)).toBeUndefined();
    }
    expect(decodeCredentialProfilesCommand({
      command: "remove",
      providerId: "fixture-provider",
      credentialId: "credential-a",
      expectedRevision: "revision-a",
      value: "raw-secret",
    })).toBeUndefined();
  });

  it("rejects any result that carries credential payload or an invalid projection", () => {
    expect(decodeCredentialProfilesCommandResult({ outcome: "ok", state })).toEqual({
      outcome: "ok",
      state,
    });
    expect(decodeProviderProfileAuthCommandResult({ outcome: "ok", state })).toEqual({
      outcome: "ok",
      state,
    });
    expect(decodeCredentialProfilesCommandResult({
      outcome: "ok",
      state: {
        providers: [{
          ...state.providers[0],
          profiles: [{
            ...state.providers[0].profiles[0],
            credential: { type: "api_key", key: "raw-secret" },
          }],
        }],
      },
    })).toBeUndefined();
    expect(decodeProviderProfileAuthCommandResult({
      outcome: "ok",
      state,
      accessToken: "raw-secret",
    })).toBeUndefined();
  });

  it("accepts only the bounded configured/unknown ambient status projection", () => {
    const ambientState = (status: string) => ({
      providers: [{
        providerId: "fixture-provider",
        implementationAvailable: true,
        revision: "absent",
        ambient: {
          kind: "external",
          status,
          message: "Resolved when used",
        },
        profiles: [],
      }],
    });
    expect(decodeCredentialProfilesCommandResult({
      outcome: "ok",
      state: ambientState("configured"),
    })).toBeDefined();
    expect(decodeCredentialProfilesCommandResult({
      outcome: "ok",
      state: ambientState("unknown"),
    })).toBeDefined();
    expect(decodeCredentialProfilesCommandResult({
      outcome: "ok",
      state: ambientState("verified"),
    })).toBeUndefined();
  });
});
