import { randomUUID } from "node:crypto";

export interface ReadonlyHeaders {
  get(name: string): string | null;
}

export interface RequestIdentity {
  readonly effectiveSessionId: string;
  readonly clientSessionId?: string;
}

const SESSION_HEADER_PRECEDENCE = [
  "x-session-id",
  "x-claude-code-session-id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-session-affinity",
] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function resolveRequestIdentity(
  headers: ReadonlyHeaders,
  createEffectiveSessionId: () => string = randomUUID,
): RequestIdentity {
  let clientSessionId: string | undefined;
  for (const name of SESSION_HEADER_PRECEDENCE) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && UUID_PATTERN.test(value)) {
      clientSessionId = value;
      break;
    }
  }

  const effectiveSessionId = clientSessionId ?? createEffectiveSessionId();
  if (!UUID_PATTERN.test(effectiveSessionId)) {
    throw new Error("Request identity generator returned an invalid UUID");
  }

  return Object.freeze({
    effectiveSessionId,
    ...(clientSessionId === undefined ? {} : { clientSessionId }),
  });
}
