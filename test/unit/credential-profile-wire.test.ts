import { describe, expect, it } from "vitest";

import {
  decodeCredentialProfilesCommand,
  decodeCredentialProfilesCommandResult,
  decodeProviderProfileAuthCommand,
  decodeProviderProfileAuthCommandResult,
} from "@token/application-control-plane/control-plane";

const state = {
  providers: [
    {
      providerId: "fixture-provider",
      implementationAvailable: true,
      revision: "revision-a",
      selectionGeneration: "selection-a",
      activeCredentialId: "credential-a",
      switchPolicy: { apiKeyOn429: false, oauthOn429: false },
      profiles: [
        {
          credentialId: "credential-a",
          authType: "api_key",
          acquisitionKind: "api_key",
          authMethodLabel: "Fixture API key",
          displayName: "Production",
          enabled: true,
          createdAt: 1,
          updatedAt: 2,
          lastUsedAt: 3,
          lastSucceededAt: 3,
        },
      ],
    },
  ],
} as const;

describe("Credential Profile public wire", () => {
  it("strictly decodes current management and auth commands only", () => {
    expect(
      decodeCredentialProfilesCommand({
        command: "update_metadata",
        providerId: "fixture-provider",
        credentialId: "credential-a",
        displayName: "Release",
        note: "Primary",
        expectedRevision: "revision-a",
      }),
    ).toEqual({
      command: "update_metadata",
      providerId: "fixture-provider",
      credentialId: "credential-a",
      displayName: "Release",
      note: "Primary",
      expectedRevision: "revision-a",
    });

    expect(
      decodeCredentialProfilesCommand({
        command: "reorder_profiles",
        providerId: "fixture-provider",
        credentialIds: ["credential-b", "credential-a"],
        expectedRevision: "revision-a",
      }),
    ).toEqual({
      command: "reorder_profiles",
      providerId: "fixture-provider",
      credentialIds: ["credential-b", "credential-a"],
      expectedRevision: "revision-a",
    });

    expect(
      decodeCredentialProfilesCommand({
        command: "cancel_management",
        operationId: "operation-a",
      }),
    ).toEqual({
      command: "cancel_management",
      operationId: "operation-a",
    });

    expect(
      decodeProviderProfileAuthCommand({
        command: "login",
        providerId: "fixture-provider",
        acquisitionKind: "local_oauth",
        displayName: "Production",
      }),
    ).toEqual({
      command: "login",
      providerId: "fixture-provider",
      acquisitionKind: "local_oauth",
      displayName: "Production",
    });

    for (const obsolete of [
      {
        command: "reconnect",
        providerId: "fixture-provider",
        credentialId: "credential-a",
        expectedRevision: "revision-a",
      },
      {
        command: "recheck",
        providerId: "fixture-provider",
        credentialId: "credential-a",
        expectedRevision: "revision-a",
      },
      {
        command: "set_priority",
        providerId: "fixture-provider",
        credentialId: "credential-a",
        priority: 1,
        expectedRevision: "revision-a",
      },
      {
        command: "login",
        providerId: "fixture-provider",
        acquisitionKind: "api_key",
        displayName: "Production",
        useNow: true,
      },
      {
        command: "login",
        providerId: "fixture-provider",
        acquisitionKind: "api_key",
        displayName: "Production",
        expectedRevision: "revision-a",
      },
    ]) {
      expect(decodeProviderProfileAuthCommand(obsolete)).toBeUndefined();
      expect(decodeCredentialProfilesCommand(obsolete)).toBeUndefined();
    }
  });

  it("accepts only the minimal public Profile projection", () => {
    expect(
      decodeCredentialProfilesCommandResult({ outcome: "ok", state }),
    ).toEqual({
      outcome: "ok",
      state,
    });
    expect(
      decodeProviderProfileAuthCommandResult({ outcome: "ok", state }),
    ).toEqual({
      outcome: "ok",
      state,
    });

    for (const internal of [
      { credential: { type: "api_key", key: "raw-secret" } },
      { strategyId: "codex_local" },
      { reference: { owner: "managed", path: "secret.auth.json" } },
      { health: "ready" },
      { priority: 0 },
      { identityHint: "•••• 1234" },
    ]) {
      expect(
        decodeCredentialProfilesCommandResult({
          outcome: "ok",
          state: {
            providers: [
              {
                ...state.providers[0],
                profiles: [
                  {
                    ...state.providers[0].profiles[0],
                    ...internal,
                  },
                ],
              },
            ],
          },
        }),
      ).toBeUndefined();
    }
  });

  it("accepts bounded configured/unknown ambient status only", () => {
    const ambientState = (status: string, displayName?: unknown) => ({
      providers: [
        {
          providerId: "fixture-provider",
          implementationAvailable: true,
          revision: "absent",
          ambient: {
            kind: "external",
            status,
            message: "Resolved when used",
            ...(displayName === undefined ? {} : { displayName }),
          },
          profiles: [],
        },
      ],
    });

    expect(
      decodeCredentialProfilesCommandResult({
        outcome: "ok",
        state: ambientState("configured", "Codex login"),
      }),
    ).toBeDefined();
    expect(
      decodeCredentialProfilesCommandResult({
        outcome: "ok",
        state: ambientState("unknown"),
      }),
    ).toBeDefined();
    expect(
      decodeCredentialProfilesCommandResult({
        outcome: "ok",
        state: ambientState("connected"),
      }),
    ).toBeUndefined();
    expect(
      decodeCredentialProfilesCommandResult({
        outcome: "ok",
        state: ambientState("configured", "x".repeat(65)),
      }),
    ).toBeUndefined();
  });

  it("accepts bounded management busy metadata without exposing guard state globally", () => {
    expect(
      decodeCredentialProfilesCommandResult({
        outcome: "management_operation_in_progress",
        state,
        activeOperation: {
          operationId: "operation-a",
          kind: "acquire_oauth",
          providerId: "fixture-provider",
          startedAt: 1,
        },
        error: "Another credential management operation is still in progress",
      }),
    ).toBeDefined();

    expect(
      decodeCredentialProfilesCommandResult({
        outcome: "management_operation_in_progress",
        state,
        activeOperation: {
          operationId: "operation-a",
          kind: "x".repeat(65),
          startedAt: 1,
        },
      }),
    ).toBeUndefined();
  });
});
