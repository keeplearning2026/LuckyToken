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
    super(input.message, options);
    this.name = "CommandCodeNeutralFailureError";
    this.failure = createUpstreamFailureFact(input);
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
