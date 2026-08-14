import {
  createUpstreamFailureFact,
  type InvocationAttempt,
  type UpstreamFailureFact,
  type UpstreamFailureFactInput,
} from "@luckytoken/provider-contract/diagnostics";

const retryHeadersByError = new WeakMap<Error, Readonly<Record<string, string>>>();

export class CommandCodeNeutralFailureError extends Error {
  readonly failure: UpstreamFailureFact;
  readonly attempts: readonly InvocationAttempt[];

  constructor(
    input: UpstreamFailureFactInput,
    options?: ErrorOptions,
    attempts: readonly InvocationAttempt[] = [],
  ) {
    const failure = createUpstreamFailureFact(input);
    super(failure.message, options);
    this.name = "CommandCodeNeutralFailureError";
    this.failure = failure;
    this.attempts = Object.freeze([...attempts]);
  }
}

export function commandCodeNeutralFailure(
  input: UpstreamFailureFactInput,
  cause?: unknown,
): CommandCodeNeutralFailureError {
  return new CommandCodeNeutralFailureError(
    input,
    cause === undefined ? undefined : { cause },
  );
}

export function attachCommandCodeRetryHeaders<T extends Error>(
  error: T,
  headers: Headers,
): T {
  const retryAfter = headers.get("retry-after");
  const retryAfterMs = headers.get("retry-after-ms");
  retryHeadersByError.set(
    error,
    Object.freeze({
      ...(retryAfter === null ? {} : { "retry-after": retryAfter }),
      ...(retryAfterMs === null ? {} : { "retry-after-ms": retryAfterMs }),
    }),
  );
  return error;
}

export function commandCodeRetryHeaders(
  error: unknown,
): Headers | undefined {
  if (!(error instanceof Error)) return undefined;
  const values = retryHeadersByError.get(error);
  return values === undefined ? undefined : new Headers(values);
}

export function withCommandCodeAttemptSummaries(
  error: CommandCodeNeutralFailureError,
  attempts: readonly InvocationAttempt[],
): CommandCodeNeutralFailureError {
  const failure = error.failure;
  return new CommandCodeNeutralFailureError(
    {
      kind: failure.kind,
      ...(failure.phase === undefined ? {} : { phase: failure.phase }),
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.statusText === undefined
        ? {}
        : { statusText: failure.statusText }),
      ...(failure.providerType === undefined
        ? {}
        : { providerType: failure.providerType }),
      ...(failure.providerCode === undefined
        ? {}
        : { providerCode: failure.providerCode }),
      message: failure.message,
      ...(failure.snapshot === undefined ? {} : { snapshot: failure.snapshot }),
      headers: failure.headers,
      ...(failure.retryable === undefined
        ? {}
        : { retryable: failure.retryable }),
      ...(attempts.length === 0 ? {} : { attemptCount: attempts.length }),
      truncated: failure.truncated,
    },
    { cause: error },
    attempts,
  );
}
