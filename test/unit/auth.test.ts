import { describe, expect, it, vi } from "vitest";

import { createAuth } from "../../src/auth.js";

const primarySession = "00000000-0000-4000-8000-000000000010";
const secondarySession = "00000000-0000-4000-8000-000000000011";
const fallbackSession = "00000000-0000-4000-8000-000000000012";

function authorizedHeaders(extra?: Record<string, string>): Headers {
  return new Headers({
    authorization: "Bearer valid-client-token",
    ...extra,
  });
}

describe("Auth.resolve", () => {
  it("denies an unusable bearer credential without exposing lookup state", async () => {
    const auth = createAuth({
      authorizeToken: async () => undefined,
      createEffectiveSessionId: () => fallbackSession,
    });

    await expect(
      auth.resolve(new Headers({ authorization: "Bearer invalid-client-token" })),
    ).resolves.toEqual({ authorized: false });
  });

  it("returns only normalized session and project facts for an authorized request", async () => {
    const authorizeToken = vi.fn(async (token: string) =>
      token === "valid-client-token" ? { projectDir: "D:/project/example" } : undefined,
    );
    const auth = createAuth({
      authorizeToken,
      createEffectiveSessionId: () => fallbackSession,
    });

    const result = await auth.resolve(
      authorizedHeaders({ "x-session-id": primarySession }),
    );

    expect(result).toEqual({
      authorized: true,
      effectiveSessionId: primarySession,
      clientSessionId: primarySession,
      projectDir: "D:/project/example",
    });
    expect(authorizeToken).toHaveBeenCalledWith("valid-client-token");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("sessionSource");
  });

  it("accepts the official Anthropic SDK x-api-key credential form", async () => {
    const authorizeToken = vi.fn(async (token: string) =>
      token === "valid-client-token" ? {} : undefined,
    );
    const auth = createAuth({
      authorizeToken,
      createEffectiveSessionId: () => fallbackSession,
    });

    await expect(
      auth.resolve(new Headers({ "x-api-key": "valid-client-token" })),
    ).resolves.toEqual({
      authorized: true,
      effectiveSessionId: fallbackSession,
    });
    expect(authorizeToken).toHaveBeenCalledWith("valid-client-token");
  });

  it("rejects conflicting bearer and x-api-key credentials", async () => {
    const authorizeToken = vi.fn(async () => ({}));
    const auth = createAuth({
      authorizeToken,
      createEffectiveSessionId: () => fallbackSession,
    });

    await expect(
      auth.resolve(
        new Headers({
          authorization: "Bearer first-client-token",
          "x-api-key": "second-client-token",
        }),
      ),
    ).resolves.toEqual({ authorized: false });
    expect(authorizeToken).not.toHaveBeenCalled();
  });

  it("uses the documented session-header precedence when aliases conflict", async () => {
    const createEffectiveSessionId = vi.fn(() => fallbackSession);
    const auth = createAuth({
      authorizeToken: async () => ({}),
      createEffectiveSessionId,
    });

    await expect(
      auth.resolve(
        authorizedHeaders({
          "x-session-id": primarySession,
          "x-client-request-id": secondarySession,
        }),
      ),
    ).resolves.toEqual({
      authorized: true,
      effectiveSessionId: primarySession,
      clientSessionId: primarySession,
    });
    expect(createEffectiveSessionId).not.toHaveBeenCalled();
  });

  it("creates an internal effective session id for absent or unusable client identities", async () => {
    const createEffectiveSessionId = vi.fn(() => fallbackSession);
    const auth = createAuth({
      authorizeToken: async () => ({}),
      createEffectiveSessionId,
    });

    await expect(auth.resolve(authorizedHeaders())).resolves.toEqual({
      authorized: true,
      effectiveSessionId: fallbackSession,
    });
    await expect(
      auth.resolve(authorizedHeaders({ "x-session-id": "not-a-uuid" })),
    ).resolves.toEqual({
      authorized: true,
      effectiveSessionId: fallbackSession,
    });
    expect(createEffectiveSessionId).toHaveBeenCalledTimes(2);
  });

  it("keeps the effective session id internal when the client supplied its own", async () => {
    const createEffectiveSessionId = vi.fn(() => fallbackSession);
    const auth = createAuth({
      authorizeToken: async () => ({}),
      createEffectiveSessionId,
    });

    const result = await auth.resolve(
      authorizedHeaders({ "x-session-id": primarySession }),
    );
    // The client identity and the internal identity never substitute for
    // each other: the client's own valid header is retained as the effective
    // identity, and no second identity is generated.
    expect(result).toEqual({
      authorized: true,
      effectiveSessionId: primarySession,
      clientSessionId: primarySession,
    });
    expect(createEffectiveSessionId).not.toHaveBeenCalled();
  });

  it("records only the client identity and project facts for authorized requests", async () => {
    const onAuthorized = vi.fn();
    const auth = createAuth({
      authorizeToken: async () => ({ projectDir: "C:\\canonical\\project" }),
      createEffectiveSessionId: () => fallbackSession,
      onAuthorized,
    });

    await auth.resolve(
      authorizedHeaders({ "x-session-id": primarySession }),
    );
    // The observation fact carries the client identity and project context
    // but never the internal effective session identity.
    expect(onAuthorized).toHaveBeenCalledWith({
      clientSessionId: primarySession,
      projectDir: "C:\\canonical\\project",
    });

    await auth.resolve(authorizedHeaders());
    expect(onAuthorized).toHaveBeenLastCalledWith({
      projectDir: "C:\\canonical\\project",
    });
    expect(
      JSON.stringify(onAuthorized.mock.calls),
    ).not.toContain(fallbackSession);
  });

  it("never observes denied requests", async () => {
    const onAuthorized = vi.fn();
    const auth = createAuth({
      authorizeToken: async () => undefined,
      createEffectiveSessionId: () => fallbackSession,
      onAuthorized,
    });
    await auth.resolve(authorizedHeaders());
    expect(onAuthorized).not.toHaveBeenCalled();
  });
});
