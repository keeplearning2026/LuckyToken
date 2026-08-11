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
      createFallbackSessionId: () => fallbackSession,
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
      createFallbackSessionId: () => fallbackSession,
    });

    const result = await auth.resolve(
      authorizedHeaders({ "x-session-id": primarySession }),
    );

    expect(result).toEqual({
      authorized: true,
      sessionId: primarySession,
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
      createFallbackSessionId: () => fallbackSession,
    });

    await expect(
      auth.resolve(new Headers({ "x-api-key": "valid-client-token" })),
    ).resolves.toEqual({ authorized: true, sessionId: fallbackSession });
    expect(authorizeToken).toHaveBeenCalledWith("valid-client-token");
  });

  it("rejects conflicting bearer and x-api-key credentials", async () => {
    const authorizeToken = vi.fn(async () => ({}));
    const auth = createAuth({
      authorizeToken,
      createFallbackSessionId: () => fallbackSession,
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
    const createFallbackSessionId = vi.fn(() => fallbackSession);
    const auth = createAuth({
      authorizeToken: async () => ({}),
      createFallbackSessionId,
    });

    await expect(
      auth.resolve(
        authorizedHeaders({
          "x-session-id": primarySession,
          "x-client-request-id": secondarySession,
        }),
      ),
    ).resolves.toEqual({ authorized: true, sessionId: primarySession });
    expect(createFallbackSessionId).not.toHaveBeenCalled();
  });

  it("generates one fallback for absent or unusable session identities", async () => {
    const createFallbackSessionId = vi.fn(() => fallbackSession);
    const auth = createAuth({
      authorizeToken: async () => ({}),
      createFallbackSessionId,
    });

    await expect(auth.resolve(authorizedHeaders())).resolves.toEqual({
      authorized: true,
      sessionId: fallbackSession,
    });
    await expect(
      auth.resolve(authorizedHeaders({ "x-session-id": "not-a-uuid" })),
    ).resolves.toEqual({
      authorized: true,
      sessionId: fallbackSession,
    });
    expect(createFallbackSessionId).toHaveBeenCalledTimes(2);
  });
});
