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
    projectDir: "C:\\Users\\fixture\\projects\\alpha",
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
      projectDir: "C:\\Users\\fixture\\projects\\alpha",
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
      decodeRequestLedgerRecord(
        validRecord({ projectDir: "x".repeat(2_048) }),
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
        realModelId: "claude-fixture",
        projectDir: "C:\\projects",
        outcome: "failed",
        from: 100,
        to: 200,
      }),
    ).toMatchObject({
      afterId: 5,
      limit: 20,
      protocolId: "anthropic-messages",
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
    // Unknown keys are rejected, consistent with the record/event allowlists.
    expect(decodeRequestLedgerQuery({ unknown: 1 })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ afterId: 5, extra: true })).toBeUndefined();
    expect(decodeRequestLedgerQuery({ outcome: "success", filter: "x" })).toBeUndefined();
  });
});