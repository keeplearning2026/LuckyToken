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
      /**
       * The always-present internal Pi invocation identity (Ticket 17): a
       * valid client-supplied session id is retained as the effective
       * identity, otherwise one is created. This identity is internal: it
       * must never be projected as the client's supplied id.
       */
      effectiveSessionId: string;
      /**
       * The client-provided session identity. Exists only when the client
       * supplied a valid supported session header; never synthesized and
       * never substituted for by the effective identity.
       */
      clientSessionId?: string;
      projectDir?: string;
    };

/** Public request-identity fact observed after successful authorization:
 *  the internal effective session identity is deliberately absent. */
export interface AuthorizedRequestIdentity {
  readonly clientSessionId?: string;
  readonly projectDir?: string;
}

export interface Auth {
  resolve(headers: ReadonlyHeaders): Promise<AuthResult>;
}

export interface AuthDependencies {
  authorizeToken(
    token: string,
  ): AuthorizedClient | undefined | Promise<AuthorizedClient | undefined>;
  /** Creates the internal effective session identity (a UUID). */
  createEffectiveSessionId(): string;
  /**
   * Optional observation hook (Ticket 17 identity seam): invoked after
   * every successful authorization with only the client identity and
   * project facts. The effective session identity never reaches observers.
   */
  onAuthorized?(identity: AuthorizedRequestIdentity): void;
}

const SESSION_HEADER_PRECEDENCE = ["x-session-id", "x-client-request-id","x-session-affinity"] as const;
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

function parseClientSessionId(headers: ReadonlyHeaders): string | undefined {
  for (const name of SESSION_HEADER_PRECEDENCE) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && UUID_PATTERN.test(value)) return value;
  }
  return undefined;
}

export function createAuth(dependencies: AuthDependencies): Auth {
  return {
    async resolve(headers): Promise<AuthResult> {
      const credential = parseClientCredential(headers);
      if (credential === undefined) return { authorized: false };

      const authorizedClient = await dependencies.authorizeToken(credential);
      if (authorizedClient === undefined) return { authorized: false };

      const clientSessionId = parseClientSessionId(headers);
      const effectiveSessionId =
        clientSessionId ?? dependencies.createEffectiveSessionId();
      if (!UUID_PATTERN.test(effectiveSessionId)) {
        throw new Error("Auth identity generator returned an invalid UUID");
      }
      const identity: AuthorizedRequestIdentity = {
        ...(clientSessionId === undefined
          ? {}
          : { clientSessionId }),
        ...(authorizedClient.projectDir === undefined
          ? {}
          : { projectDir: authorizedClient.projectDir }),
      };
      dependencies.onAuthorized?.(identity);
      return {
        authorized: true,
        effectiveSessionId,
        ...(clientSessionId === undefined ? {} : { clientSessionId }),
        ...(authorizedClient.projectDir === undefined
          ? {}
          : { projectDir: authorizedClient.projectDir }),
      };
    },
  };
}
