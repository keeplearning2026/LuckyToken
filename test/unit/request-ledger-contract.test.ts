import { describe, expect, it } from "vitest";

import {
  decodeRequestLedgerQuery,
  decodeRequestLedgerRecord,
} from "../../packages/application-control-plane/src/wire-ledger.js";

/**
 * Ticket 18 wire-contract unit tests: the strict allowlist decoders of the
 * Request Ledger surface. A frame with an unknown key, an invalid bounded
 * value, or the effective session identity projected as the client id is
 * rejected — never projected.
 */

const clientSessionId = "20000000-0000-4000-8000-000000000031";
const effectiveSessionId = "30000000-0000-4000-8000-000000000032";

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    requestId: "10000000-0000-4000-8000-000000000001",
    protocolId: "anthropic-messages",
    phase: "terminal-preparation",
    outcome: "success",
    acceptedAt: 1_700_000_000_000,
    executionStartedAt: 1_700_000_000_001,
    terminalAt: 1_700_000_000_002,
    completedAt: 1_700_000_000_003,
    clientHttpStatus: 200,
    externalAlias: "alpha",
    providerId: "commandcode-private",
    realModelId: "claude-fixture",
    clientSessionId,
    effectiveSessionId,
    ...overrides,
  };
}

describe("Request Ledger wire contract", () => {
  it("decodes a full record with every bounded field under its own key", () => {
    const record = decodeRequestLedgerRecord(validRecord());
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      id: 1,
      requestId: "10000000-0000-4000-8000-000000000001",
      protocolId: "anthropic-messages",
      phase: "terminal-preparation",
      outcome: "success",
      acceptedAt: 1_700_000_000_000,
      clientHttpStatus: 200,
      externalAlias: "alpha",
      providerId: "commandcode-private",
      realModelId: "claude-fixture",
      clientSessionId,
      effectiveSessionId,
    });
    expect(record!.facts).toBeUndefined();
  });

  it("never copies the effective session identity into the client session field", () => {
    // A record with only the effective identity decodes with NO client
    // session field; the decoder has no path that substitutes one for the
    // other.
    const record = decodeRequestLedgerRecord(
      validRecord({ clientSessionId: undefined }),
    );
    expect(record).toBeDefined();
    expect(record!.effectiveSessionId).toBe(effectiveSessionId);
    expect(record!.clientSessionId).toBeUndefined();
    expect("clientSessionId" in record!).toBe(false);

    // A frame carrying the effective identity under the client key is
    // rejected: the client key must hold a client-supplied UUID or be absent
    // — the decoder never accepts an arbitrary value in its place.
    expect(
      decodeRequestLedgerRecord(
        validRecord({ clientSessionId: "not-a-uuid-or-session" }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ clientSessionId: 42 }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ effectiveSessionId: "not-a-uuid" }),
      ),
    ).toBeUndefined();
  });

  it("rejects frames with unknown keys or out-of-bounds values", () => {
    expect(decodeRequestLedgerRecord(validRecord({ leaked: "x" }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ "effective_session_id": effectiveSessionId }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ id: 0 }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ requestId: "Bearer canary" }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ phase: "delivered" }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ outcome: "cancelled" }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ acceptedAt: -1 }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ clientHttpStatus: 42 }))).toBeUndefined();
    expect(decodeRequestLedgerRecord(validRecord({ protocolId: "" }))).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(validRecord({ projectDir: "C:\\project" })),
    ).toBeUndefined();
  });

  const completeSnapshot = {
    api: "commandcode-private",
    input: 5,
    cacheRead: 4,
    cacheWrite: 3,
    output: 2,
    reasoning: 1,
    normalizedTotal: 14,
    cacheHitRate: 4 / 12,
    completeness: "complete",
    evidence: "packages/provider-commandcode-private/src/semantic.ts:150-270",
  };

  it("decodes a complete terminal-usage snapshot under its own field", () => {
    const record = decodeRequestLedgerRecord(
      validRecord({ terminalUsage: completeSnapshot }),
    );
    expect(record).toBeDefined();
    expect(record!.terminalUsage).toEqual(completeSnapshot);
    expect(Object.isFrozen(record!.terminalUsage)).toBe(true);
  });

  it("decodes partial and unavailable snapshots with their reason", () => {
    const partial = decodeRequestLedgerRecord(
      validRecord({
        terminalUsage: {
          api: "anthropic-messages",
          input: 7,
          cacheRead: 1,
          cacheWrite: 0,
          output: 0,
          completeness: "partial",
          reason: "aborted",
          evidence: "pi-agent/packages/ai/src/api/anthropic-messages.ts:574-586",
        },
      }),
    );
    expect(partial!.terminalUsage).toMatchObject({
      completeness: "partial",
      reason: "aborted",
      input: 7,
      cacheRead: 1,
    });
    expect(partial!.terminalUsage!.normalizedTotal).toBeUndefined();

    const unavailable = decodeRequestLedgerRecord(
      validRecord({
        terminalUsage: {
          api: "faux",
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          completeness: "unavailable",
          reason: "unsupported_terminal",
        },
      }),
    );
    expect(unavailable!.terminalUsage).toMatchObject({
      completeness: "unavailable",
      reason: "unsupported_terminal",
    });
  });

  it("rejects malformed terminal-usage snapshots instead of projecting them", () => {
    expect(
      decodeRequestLedgerRecord(validRecord({ terminalUsage: "usage" })),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ terminalUsage: { ...completeSnapshot, leaked: 1 } }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ terminalUsage: { ...completeSnapshot, normalizedTotal: 15 } }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ terminalUsage: { ...completeSnapshot, reason: "failed" } }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ terminalUsage: { ...completeSnapshot, completeness: "partial" } }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ terminalUsage: { ...completeSnapshot, input: -2 } }),
      ),
    ).toBeUndefined();
  });

  it("decodes bounded facts and rejects malformed or oversized facts", () => {
    const record = decodeRequestLedgerRecord(
      validRecord({
        facts: {
          notices: [
            {
              adapter: "anthropic-messages",
              direction: "request",
              code: "field_ignored",
              jsonPath: "$.metadata",
              action: "ignore",
            },
          ],
          attempts: [
            {
              attempt: 1,
              classification: "retryable",
              stage: "transport",
              status: 429,
              retryable: true,
              safeIds: { requestId: "upstream-42" },
            },
          ],
          failure: {
            classification: "runtime-failure",
            messageHash: "a".repeat(64),
          },
          persistenceWarnings: 3,
          piStopReason: "stop",
          profileAttribution: {
            profileId: "credential-backup",
            displayName: "Backup",
          },
          credentialCapture: {
            credentialId: "credential-primary",
            displayName: "Production",
            authType: "api_key",
            authMethodLabel: "OpenAI API key",
            lane: "provider_native",
            selectionReason: "active",
          },
          credentialAttempts: [{
            credentialId: "credential-backup",
            displayName: "Backup",
            authType: "api_key",
            authMethodLabel: "OpenAI API key",
            lane: "provider_native",
            selectionReason: "http_429_switch",
            attempt: 2,
            outcome: "success",
          }],
        },
      }),
    );
    expect(record).toBeDefined();
    expect(record!.facts).toMatchObject({
      notices: [{ adapter: "anthropic-messages", jsonPath: "$.metadata" }],
      attempts: [{ attempt: 1, safeIds: { requestId: "upstream-42" } }],
      failure: { classification: "runtime-failure" },
      persistenceWarnings: 3,
      piStopReason: "stop",
      profileAttribution: {
        profileId: "credential-backup",
        displayName: "Backup",
      },
      credentialCapture: { displayName: "Production" },
      credentialAttempts: [{ displayName: "Backup", outcome: "success" }],
    });

    expect(
      decodeRequestLedgerRecord(
        validRecord({ facts: { notices: [{ adapter: 42 }] } }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({
          facts: { notices: Array.from({ length: 65 }, () => ({})) },
        }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ facts: { unknownFact: true } }),
      ),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(validRecord({
        facts: {
          credentialCapture: {
            credentialId: "credential-primary",
            displayName: "Production",
            authType: "api_key",
            authMethodLabel: "OpenAI API key",
            lane: "provider_native",
            selectionReason: "active",
            note: "must not cross the Activity wire",
          },
        },
      })),
    ).toBeUndefined();
    expect(
      decodeRequestLedgerRecord(
        validRecord({ facts: { failure: { classification: "x", messageHash: "not-hex" } } }),
      ),
    ).toBeUndefined();
  });

  it("decodes queries with bounded filters and rejects malformed ones", () => {
    expect(decodeRequestLedgerQuery(undefined)).toBeUndefined();
    expect(
      decodeRequestLedgerQuery({
        afterId: 5,
        limit: 20,
        protocolId: "anthropic-messages",
        providerId: "commandcode-private",
        profileId: "credential-backup",
        realModelId: "claude-fixture",
        outcome: "failed",
        from: 100,
        to: 200,
      }),
    ).toMatchObject({
      afterId: 5,
      limit: 20,
      protocolId: "anthropic-messages",
      profileId: "credential-backup",
      outcome: "failed",
      from: 100,
      to: 200,
    });
    expect(decodeRequestLedgerQuery({ afterId: -1 })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ afterId: 1.5 })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ limit: 0 })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ limit: 1_001 })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ outcome: "cancelled" })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ from: 200, to: 100 })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ protocolId: "" })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ projectDir: "C:\\projects" })).toBeUndefined();
    // Unknown keys are rejected, consistent with the record/event allowlists.
    expect(decodeRequestLedgerQuery({ unknown: 1 })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ afterId: 5, extra: true })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ outcome: "success", filter: "x" })).toBeUndefined();
  });

});
