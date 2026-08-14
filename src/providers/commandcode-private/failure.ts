import {
  createUpstreamFailureFact,
  type UpstreamFailureFact,
  type UpstreamFailureFactInput,
} from "../../protocols/upstream-failure.js";

export class CommandCodeNeutralFailureError extends Error {
  readonly failure: UpstreamFailureFact;

  constructor(
    input: UpstreamFailureFactInput,
    options?: ErrorOptions,
  ) {
    const failure = createUpstreamFailureFact(input);
    super(failure.message, options);
    this.name = "CommandCodeNeutralFailureError";
    this.failure = failure;
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
