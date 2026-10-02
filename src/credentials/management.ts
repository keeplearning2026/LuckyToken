export type CredentialManagementOperationKind =
  | "acquire_api_key"
  | "acquire_oauth"
  | "acquire_local_oauth"
  | "activate"
  | "set_enabled"
  | "update_metadata"
  | "reorder"
  | "remove"
  | "set_switch_policy";

export interface ActiveCredentialManagementOperation {
  readonly operationId: string;
  readonly kind: CredentialManagementOperationKind;
  readonly providerId?: string;
  readonly startedAt: number;
}

export class CredentialManagementBusyError extends Error {
  readonly code = "management_operation_in_progress" as const;

  constructor(
    readonly activeOperation: ActiveCredentialManagementOperation,
  ) {
    super("Another credential management operation is still in progress");
    this.name = "CredentialManagementBusyError";
  }
}

export class CredentialManagementCancelledError extends Error {
  readonly code = "management_operation_cancelled" as const;

  constructor() {
    super("Credential management operation cancelled");
    this.name = "CredentialManagementCancelledError";
  }
}

export interface CredentialManagementGuard {
  run<T>(
    input: {
      readonly kind: CredentialManagementOperationKind;
      readonly providerId?: string;
      readonly signal?: AbortSignal;
      readonly deadlineMs?: number;
    },
    operation: (
      signal: AbortSignal,
      operationId: string,
    ) => Promise<T>,
  ): Promise<T>;

  cancel(operationId: string): boolean;
}

export const DEFAULT_CREDENTIAL_MANAGEMENT_DEADLINE_MS = 15 * 60_000;

export function createCredentialManagementGuard(options: {
  readonly createId: () => string;
  readonly now?: () => number;
  readonly defaultDeadlineMs?: number;
}): CredentialManagementGuard {
  const now = options.now ?? Date.now;
  const defaultDeadlineMs =
    options.defaultDeadlineMs ?? DEFAULT_CREDENTIAL_MANAGEMENT_DEADLINE_MS;

  let active:
    | {
        readonly facts: ActiveCredentialManagementOperation;
        readonly controller: AbortController;
      }
    | undefined;

  return Object.freeze({
    async run<T>(
      input: {
        readonly kind: CredentialManagementOperationKind;
        readonly providerId?: string;
        readonly signal?: AbortSignal;
        readonly deadlineMs?: number;
      },
      operation: (
        signal: AbortSignal,
        operationId: string,
      ) => Promise<T>,
    ): Promise<T> {
      if (active !== undefined) {
        throw new CredentialManagementBusyError(active.facts);
      }

      const controller = new AbortController();
      const operationId = options.createId();
      const facts: ActiveCredentialManagementOperation = Object.freeze({
        operationId,
        kind: input.kind,
        ...(input.providerId === undefined
          ? {}
          : { providerId: input.providerId }),
        startedAt: now(),
      });
      active = { facts, controller };

      const deadlineMs = input.deadlineMs ?? defaultDeadlineMs;
      const deadline =
        Number.isSafeInteger(deadlineMs) && deadlineMs > 0
          ? AbortSignal.timeout(deadlineMs)
          : undefined;
      const signal = AbortSignal.any(
        [
          controller.signal,
          ...(input.signal === undefined ? [] : [input.signal]),
          ...(deadline === undefined ? [] : [deadline]),
        ],
      );

      try {
        signal.throwIfAborted();
        return await operation(signal, operationId);
      } finally {
        if (active?.facts.operationId === operationId) {
          active = undefined;
        }
      }
    },

    cancel(operationId: string): boolean {
      if (active?.facts.operationId !== operationId) return false;
      active.controller.abort(new CredentialManagementCancelledError());
      return true;
    },
  });
}
