export interface ReadonlyHeaders {
  get(name: string): string | null;
}

export interface AuthorizedClient {
  readonly projectDir?: string;
}

export type AuthResult =
  | { authorized: false }
  | {
      authorized: true;
      sessionId: string;
      projectDir?: string;
    };

export interface Auth {
  resolve(headers: ReadonlyHeaders): Promise<AuthResult>;
}

export interface AuthDependencies {
  authorizeToken(
    token: string,
  ): AuthorizedClient | undefined | Promise<AuthorizedClient | undefined>;
  createFallbackSessionId(): string;
}

const SESSION_HEADER_PRECEDENCE = ["x-session-id", "x-client-request-id"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseClientCredential(headers: ReadonlyHeaders): string | undefined {
  const authorization = headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/iu);
  const bearer = match?.[1]?.trim();
  const apiKey = headers.get("x-api-key")?.trim();
  const usableBearer = bearer && bearer.length > 0 ? bearer : undefined;
  const usableApiKey = apiKey && apiKey.length > 0 ? apiKey : undefined;
  if (
    usableBearer !== undefined &&
    usableApiKey !== undefined &&
    usableBearer !== usableApiKey
  ) {
    return undefined;
  }
  return usableApiKey ?? usableBearer;
}

function resolveSessionId(
  headers: ReadonlyHeaders,
  createFallbackSessionId: () => string,
): string {
  for (const name of SESSION_HEADER_PRECEDENCE) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && UUID_PATTERN.test(value)) return value;
  }

  const fallback = createFallbackSessionId();
  if (!UUID_PATTERN.test(fallback)) {
    throw new Error("Auth fallback identity generator returned an invalid UUID");
  }
  return fallback;
}

export function createAuth(dependencies: AuthDependencies): Auth {
  return {
    async resolve(headers): Promise<AuthResult> {
      const credential = parseClientCredential(headers);
      if (credential === undefined) return { authorized: false };

      const authorizedClient = await dependencies.authorizeToken(credential);
      if (authorizedClient === undefined) return { authorized: false };

      const sessionId = resolveSessionId(
        headers,
        dependencies.createFallbackSessionId,
      );
      if (authorizedClient.projectDir === undefined) {
        return { authorized: true, sessionId };
      }
      return {
        authorized: true,
        sessionId,
        projectDir: authorizedClient.projectDir,
      };
    },
  };
}
