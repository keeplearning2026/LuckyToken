import { describe, expect, it } from "vitest";

import {
  createRequestIdentityObserver,
  projectRequestIdentity,
  type RequestIdentityFact,
} from "../../src/request-observation/index.js";

const clientSession = "00000000-0000-4000-8000-000000000010";
const effectiveSession = "00000000-0000-4000-8000-000000000011";

/**
 * Ticket 17 identity seam (Ticket 18 handoff): the public request-identity
 * projection carries the optional client-provided session id and renders a
 * missing one as "-". The internal effective session identity is never part
 * of the observation contract, so a future ledger cannot accidentally show
 * `effectiveSessionId` as `clientSessionId`.
 */
describe("request identity observation and projection", () => {
  it("projects the provided client session id verbatim", () => {
    const record = createRequestIdentityObserver({
      now: () => 1_700_000_000_000,
    })
      .observe("anthropic-messages", { clientSessionId: clientSession })
      .list()[0]!;
    expect(record).toEqual({
      id: 1,
      time: 1_700_000_000_000,
      protocolId: "anthropic-messages",
      clientSessionId: clientSession,
    });
    expect(projectRequestIdentity(record)).toEqual({
      id: 1,
      time: 1_700_000_000_000,
      protocolId: "anthropic-messages",
      clientSessionId: clientSession,
    });
  });

  it("renders a missing client session id as - and keeps the fact absent", () => {
    const observer = createRequestIdentityObserver({
      now: () => 1_700_000_000_000,
    });
    // The fact type has no effectiveSessionId field at all; the client
    // identity is the only session fact that may be recorded.
    const fact: RequestIdentityFact = {};
    const record = observer.observe("openai-responses", fact).list()[0]!;
    expect(record.clientSessionId).toBeUndefined();
    expect(projectRequestIdentity(record).clientSessionId).toBe("-");
    expect(JSON.stringify(record)).not.toContain("effectiveSessionId");
    expect(JSON.stringify(record)).not.toContain(effectiveSession);
  });

  it("records the canonical projectDir as a separate optional fact", () => {
    const observer = createRequestIdentityObserver({
      now: () => 1_700_000_000_000,
    });
    const record = observer
      .observe("anthropic-messages", {
        clientSessionId: clientSession,
        projectDir: "C:\\canonical\\project",
      })
      .list()[0]!;
    expect(record).toEqual({
      id: 1,
      time: 1_700_000_000_000,
      protocolId: "anthropic-messages",
      clientSessionId: clientSession,
      projectDir: "C:\\canonical\\project",
    });
  });

  it("keeps a bounded ring of the most recent identities in order", () => {
    const observer = createRequestIdentityObserver({
      capacity: 3,
      now: () => 1_700_000_000_000,
    });
    observer.observe("anthropic-messages", {});
    observer.observe("openai-responses", {});
    observer.observe("anthropic-messages", { clientSessionId: clientSession });
    observer.observe("openai-responses", {});
    expect(observer.list().map((record) => record.id)).toEqual([4, 3, 2]);
    expect(observer.list()[1]!.clientSessionId).toBe(clientSession);
  });

  it("never exposes an effective session id through the projection", () => {
    // The internal Pi invocation identity is created and consumed only by
    // the auth boundary; the projection input has no such field, so the
    // renderer contract cannot substitute it for the client identity.
    const observer = createRequestIdentityObserver();
    const projected = projectRequestIdentity(
      observer.observe("anthropic-messages", {}).list()[0]!,
    );
    expect(projected).not.toHaveProperty("effectiveSessionId");
    expect(projected).not.toHaveProperty("sessionId");
    expect(projected.clientSessionId).toBe("-");
  });

  it("freezes returned records so no caller can inject a session fact later", () => {
    const observer = createRequestIdentityObserver();
    observer.observe("anthropic-messages", {});
    const record = observer.list()[0]!;
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      (record as { clientSessionId?: string }).clientSessionId = effectiveSession;
    }).toThrow();
  });
});
